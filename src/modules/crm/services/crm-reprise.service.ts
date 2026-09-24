import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { COMMANDE_EFFECTIVE_SQL } from '../crm.rules';

const EFFECTIVE = COMMANDE_EFFECTIVE_SQL;
const SUFFIXE = ' (rétention)';

/**
 * Reprise de l'ancien écran « Rétention clients » dans le CRM : ses raisons,
 * et ses appels, rattachés aux contacts inactifs. Les anciennes tables ne
 * sont ni modifiées ni supprimées.
 *
 * Chaque étape ne fait que ce qui manque encore : la reprise peut tourner
 * plusieurs fois, sur deux backends, sans rien doubler.
 *
 * Correspondance des résultats d'appel :
 *  - Pas de réponse → non joint ;
 *  - Rappel planifié → à rappeler, à la date prévue ;
 *  - Appelé (joint, raison notée, suite en attente) → à rappeler ;
 *  - Perdu → pas intéressé ;
 *  - Reconquis → intéressé (la commande qui a suivi fait le reste).
 */
@Injectable()
export class CrmRepriseService {
  private readonly logger = new Logger(CrmRepriseService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reprendreRetention(): Promise<Record<string, number>> {
    const [{ existe }] = await this.prisma.$queryRawUnsafe<{ existe: boolean }[]>(
      `SELECT to_regclass('public.retention_callbacks') IS NOT NULL AS existe`,
    );
    if (!existe) return { raisons: 0, reconquis: 0, appels: 0, contacts: 0 };

    return this.prisma.$transaction(
      async (tx) => {
        // Un seul backend à la fois : le verrou tombe avec la transaction.
        const [{ verrou }] = await tx.$queryRawUnsafe<{ verrou: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(727224) AS verrou`,
        );
        if (!verrou) return { raisons: 0, reconquis: 0, appels: 0, contacts: 0 };

        const raisons = await tx.$executeRawUnsafe(`
          INSERT INTO "ProspectLossReason" ("id", "name", "description", "is_active", "position", "updated_at")
          SELECT gen_random_uuid(), trim(r."name"), r."description", r."is_active",
                 (SELECT coalesce(max("position"), 0) FROM "ProspectLossReason")
                   + row_number() OVER (ORDER BY r."position", r."created_at"),
                 now()
          FROM "retention_callback_reasons" r
          WHERE r."entity_status" <> 'DELETED'
            AND NOT EXISTS (
              SELECT 1 FROM "ProspectLossReason" l
              WHERE lower(trim(l."name")) = lower(trim(r."name")) AND l."entity_status" <> 'DELETED'
            )`);

        // Clients revenus commander après un appel de rétention, et actifs
        // depuis : ils entrent au CRM comme reconquis, pour garder leur succès.
        const reconquis = await tx.$executeRawUnsafe(`
          WITH premiers AS (
            SELECT "customer_id", min("called_at") AS premier
            FROM "retention_callbacks" WHERE "entity_status" <> 'DELETED'
            GROUP BY "customer_id"
          ),
          conversion AS (
            SELECT DISTINCT ON (p."customer_id") p."customer_id", p.premier, o."id" AS order_id,
                   o."created_at" AS commande_le, o."amount"
            FROM premiers p
            JOIN "Order" o ON o."customer_id" = p."customer_id" AND ${EFFECTIVE} AND o."created_at" >= p.premier
            ORDER BY p."customer_id", o."created_at"
          ),
          nouveaux AS (
            INSERT INTO "CrmContact" ("id", "customer_id", "registered_at", "segment", "segment_since", "status",
                                      "converted_at", "conversion_order_id", "conversion_amount", "last_order_at", "updated_at")
            SELECT gen_random_uuid(), c."id", c."created_at", 'INACTIF', v.premier, 'CONVERTI',
                   v.commande_le, v.order_id, v."amount",
                   (SELECT max(o."created_at") FROM "Order" o WHERE o."customer_id" = c."id" AND ${EFFECTIVE}),
                   now()
            FROM conversion v JOIN "Customer" c ON c."id" = v."customer_id" AND c."entity_status" <> 'DELETED'
            WHERE NOT EXISTS (SELECT 1 FROM "CrmContact" x WHERE x."customer_id" = c."id")
            ON CONFLICT ("customer_id") DO NOTHING
            RETURNING "id"
          )
          INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
          SELECT gen_random_uuid(), n."id", 'CONVERSION', 'Reconquis après un appel de rétention' FROM nouveaux n`);

        const appels = await tx.$executeRawUnsafe(`
          WITH source AS (
            SELECT rc.*, x."id" AS contact_id,
              CASE rc."status" WHEN 'NO_ANSWER' THEN 'NON_JOINT' WHEN 'LOST' THEN 'NON_INTERESSE'
                               WHEN 'RECONQUERED' THEN 'INTERESSE' ELSE 'A_RAPPELER' END AS resultat,
              CASE rc."status" WHEN 'NO_ANSWER' THEN 'Pas de réponse' WHEN 'CALLBACK_SCHEDULED' THEN 'Rappel planifié'
                               WHEN 'LOST' THEN 'Perdu' WHEN 'RECONQUERED' THEN 'Reconquis' ELSE 'Appelé' END
                || '${SUFFIXE}' AS libelle,
              row_number() OVER (PARTITION BY x."id" ORDER BY rc."called_at") AS rang
            FROM "retention_callbacks" rc
            JOIN "CrmContact" x ON x."customer_id" = rc."customer_id"
            WHERE rc."entity_status" <> 'DELETED'
          )
          INSERT INTO "CrmCall" ("id", "contact_id", "segment", "agent_id", "call_status_id", "status_label", "outcome",
                                 "reached", "attempt", "loss_reason_id", "comment", "callback_at", "created_at")
          SELECT gen_random_uuid(), s.contact_id, 'INACTIF', s."caller_user_id", NULL, s.libelle,
                 s.resultat::"CrmCallOutcome", s.resultat <> 'NON_JOINT', s.rang, raison."id",
                 nullif(trim(s."notes"), ''), s."next_callback_at", s."called_at"
          FROM source s
          LEFT JOIN "retention_callback_reasons" rr ON rr."id" = s."reason_id"
          LEFT JOIN LATERAL (
            SELECT l."id" FROM "ProspectLossReason" l
            WHERE lower(trim(l."name")) = lower(trim(rr."name")) AND l."entity_status" <> 'DELETED'
            ORDER BY l."position" LIMIT 1
          ) raison ON true
          WHERE NOT EXISTS (
            SELECT 1 FROM "CrmCall" k
            WHERE k."contact_id" = s.contact_id AND k."created_at" = s."called_at" AND k."status_label" = s.libelle
          )`);

        // Les inactifs encore jamais traités dans le CRM reprennent là où
        // l'ancien écran s'était arrêté, sur les appels de leur cycle actuel.
        const contacts = await tx.$executeRawUnsafe(`
          WITH cycle AS (
            SELECT k."contact_id", count(*)::int AS n, max(k."created_at") AS dernier,
                   min(k."created_at") FILTER (WHERE k."reached") AS premier_joint
            FROM "CrmCall" k JOIN "CrmContact" x ON x."id" = k."contact_id"
            WHERE k."created_at" >= x."segment_since" AND k."status_label" LIKE '%${SUFFIXE}'
            GROUP BY k."contact_id"
          ),
          dernier AS (
            SELECT DISTINCT ON (k."contact_id") k."contact_id", k."outcome", k."comment", k."callback_at", k."loss_reason_id"
            FROM "CrmCall" k JOIN cycle ON cycle."contact_id" = k."contact_id"
            JOIN "CrmContact" x ON x."id" = k."contact_id"
            WHERE k."created_at" >= x."segment_since"
            ORDER BY k."contact_id", k."created_at" DESC
          ),
          maj AS (
            UPDATE "CrmContact" x
            SET "call_count" = cycle.n,
                "last_call_at" = cycle.dernier,
                "first_reached_at" = cycle.premier_joint,
                "last_call_outcome" = d."outcome",
                "last_comment" = d."comment",
                "loss_reason_id" = d."loss_reason_id",
                "callback_at" = CASE WHEN d."outcome" = 'A_RAPPELER' THEN d."callback_at" END,
                "qualified_at" = CASE WHEN d."outcome" IN ('INTERESSE', 'NON_INTERESSE') THEN cycle.dernier END,
                "status" = CASE d."outcome" WHEN 'A_RAPPELER' THEN 'A_RAPPELER' WHEN 'INTERESSE' THEN 'INTERESSE'
                                            WHEN 'NON_INTERESSE' THEN 'NON_INTERESSE' ELSE 'A_APPELER' END::"CrmStatus",
                "updated_at" = now()
            FROM cycle JOIN dernier d ON d."contact_id" = cycle."contact_id"
            WHERE x."id" = cycle."contact_id" AND x."status" = 'A_APPELER' AND x."call_count" = 0
            RETURNING x."id", cycle.n
          )
          INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
          SELECT gen_random_uuid(), m."id", 'APPEL',
                 m.n || CASE WHEN m.n > 1 THEN ' appels repris' ELSE ' appel repris' END || ' de l''écran Rétention clients'
          FROM maj m`);

        const bilan = { raisons, reconquis, appels, contacts };
        if (Object.values(bilan).some((n) => n > 0)) {
          this.logger.log(
            `Reprise de la rétention : ${raisons} raisons, ${reconquis} reconquis, ${appels} appels, ${contacts} contacts mis à jour`,
          );
        }
        return bilan;
      },
      { timeout: 120_000 },
    );
  }
}
