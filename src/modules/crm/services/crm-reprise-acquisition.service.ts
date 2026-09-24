import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { COMMANDE_EFFECTIVE_SQL, CRM_SETTINGS, compter } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';

const EFFECTIVE = COMMANDE_EFFECTIVE_SQL;
const CLE_CAPTURE = `right(regexp_replace(p."phone", '\\D', '', 'g'), 10)`;
const CLE_CLIENT = `right(regexp_replace(c."phone", '\\D', '', 'g'), 10)`;
const TAILLE_LOT = 500;
const VERROU_REPRISE = 727226;

/**
 * Reprise de l'acquisition Glovo/Yango dans le CRM : une fiche par personne
 * (son compte appli, sinon son numéro), ses captures, ses appels, ses coupons
 * et ses ventes. Tourne au démarrage puis toutes les 10 minutes, tant que les
 * anciennes routes de l'appli caisse existent : elle ne traite que ce qui
 * n'est pas encore rattaché, et ne double jamais rien.
 *
 * Découpée par lots de numéros, chacun dans sa transaction : une ligne en
 * erreur ne bloque que son lot, qui sera repris au passage suivant. Les
 * anciennes tables ne sont jamais modifiées, sauf le rattachement
 * `Prospect.contact_id`.
 */
@Injectable()
export class CrmRepriseAcquisitionService {
  private readonly logger = new Logger(CrmRepriseAcquisitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: CrmConfigService,
  ) {}

  async reprendre(): Promise<Record<string, number>> {
    const bascule = await this.dateDeBascule();
    const jours = await this.config.joursInactivite();
    const cles = await this.prisma.$queryRawUnsafe<{ cle: string }[]>(`
      SELECT DISTINCT ${CLE_CAPTURE} AS cle FROM "Prospect" p
      WHERE p."contact_id" IS NULL AND p."entity_status" <> 'DELETED' AND p."platform" IN ('GLOVO', 'YANGO')
        AND length(regexp_replace(p."phone", '\\D', '', 'g')) >= 6
      ORDER BY 1`);
    const bilan: Record<string, number> = { numeros: cles.length, fiches: 0, requalifiees: 0, captures: 0, appels: 0, coupons: 0, ventes: 0, lots_en_erreur: 0 };
    for (let i = 0; i < cles.length; i += TAILLE_LOT) {
      const lot = cles.slice(i, i + TAILLE_LOT).map((c) => c.cle);
      try {
        const r = await this.traiterLot(lot, bascule, jours);
        if (!r) {
          // Un autre traitement (tâche planifiée, second backend) fait déjà la reprise.
          this.logger.debug('Reprise acquisition déjà en cours ailleurs : passage ignoré');
          return { ...bilan, numeros: 0 };
        }
        for (const [cle, n] of Object.entries(r)) bilan[cle] = (bilan[cle] ?? 0) + n;
      } catch (e) {
        bilan.lots_en_erreur++;
        this.logger.error(`Reprise acquisition : lot ${i / TAILLE_LOT + 1} en erreur : ${(e as Error).message}`);
      }
    }
    if (bilan.numeros > 0) {
      this.logger.log(
        `Reprise acquisition : ${bilan.numeros} numéros, ${bilan.fiches} fiches créées, ${bilan.requalifiees} requalifiées, ` +
          `${bilan.captures} captures, ${bilan.appels} appels, ${bilan.coupons} coupons, ${bilan.ventes} ventes historiques` +
          (bilan.lots_en_erreur ? `, ${bilan.lots_en_erreur} lots en erreur` : ''),
      );
    }
    return bilan;
  }

  /** Date où le CRM a pris le relais : les ventes antérieures sont « historique acquisition ». */
  private async dateDeBascule(): Promise<Date> {
    const existante = await this.settings.get(CRM_SETTINGS.BASCULE_ACQUISITION);
    if (existante && !Number.isNaN(Date.parse(existante))) return new Date(existante);
    const maintenant = new Date();
    await this.settings.set(CRM_SETTINGS.BASCULE_ACQUISITION, maintenant.toISOString());
    return maintenant;
  }

  /** Traite un lot de numéros ; null si un autre traitement tient déjà le verrou. */
  private traiterLot(cles: string[], bascule: Date, jours: number): Promise<Record<string, number> | null> {
    return this.prisma.$transaction(
      async (tx): Promise<Record<string, number> | null> => {
        const [{ verrou }] = await tx.$queryRawUnsafe<{ verrou: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(${VERROU_REPRISE}) AS verrou`,
        );
        if (!verrou) return null;
        const q = (sql: string, ...params: unknown[]) => tx.$executeRawUnsafe(sql, ...params);

        await q(`CREATE TEMP TABLE crm_lot (
          cle text PRIMARY KEY, premier timestamp(6), plateforme text, nom text, phone text,
          customer_id uuid, inscrit_le timestamp(6), derniere timestamp(6), contact_id uuid) ON COMMIT DROP`);

        // Ce que les captures disent de chaque numéro.
        await q(
          `INSERT INTO crm_lot (cle, premier, plateforme, nom, phone)
           SELECT t.cle, min(t."created_at"),
                  (array_agg(t."platform"::text ORDER BY t."created_at" DESC))[1],
                  (array_agg(left(trim(t."name"), 120) ORDER BY t."created_at" DESC)
                     FILTER (WHERE nullif(trim(t."name"), '') IS NOT NULL AND lower(trim(t."name")) <> 'client'))[1],
                  (array_agg(left(regexp_replace(t."phone", '\\D', '', 'g'), 20) ORDER BY t."created_at" DESC))[1]
           FROM (SELECT ${CLE_CAPTURE} AS cle, p.* FROM "Prospect" p
                 WHERE p."entity_status" <> 'DELETED' AND p."platform" IN ('GLOVO', 'YANGO')) t
           WHERE t.cle = ANY($1::text[])
           GROUP BY t.cle`,
          cles,
        );

        // Le client actif de chaque numéro (sans les doublons supprimés, « + » d'abord).
        await q(`
          UPDATE crm_lot l SET customer_id = e."id", inscrit_le = e."created_at"
          FROM (SELECT DISTINCT ON (${CLE_CLIENT}) ${CLE_CLIENT} AS cle, c."id", c."created_at"
                FROM "Customer" c WHERE c."entity_status" <> 'DELETED' AND c."phone" IS NOT NULL
                ORDER BY ${CLE_CLIENT}, (c."phone" LIKE '+%') DESC, c."created_at", c."id") e
          WHERE e.cle = l.cle`);

        // Dernière commande effective du compte : sert à choisir le public d'une fiche neuve.
        await q(`UPDATE crm_lot l SET derniere = d.derniere
                 FROM (SELECT o."customer_id", max(o."created_at") AS derniere FROM "Order" o
                       WHERE ${EFFECTIVE} AND o."customer_id" IN (SELECT customer_id FROM crm_lot WHERE customer_id IS NOT NULL)
                       GROUP BY o."customer_id") d
                 WHERE d."customer_id" = l.customer_id`);

        // La fiche existante : celle du compte, sinon celle du numéro (qu'on lie au compte).
        await q(`UPDATE crm_lot l SET contact_id = x."id" FROM "CrmContact" x
                 WHERE l.customer_id IS NOT NULL AND x."customer_id" = l.customer_id`);
        await q(`UPDATE crm_lot l SET contact_id = x."id" FROM "CrmContact" x
                 WHERE l.contact_id IS NULL AND x."customer_id" IS NULL AND x."phone_key" = l.cle AND x."entity_status" <> 'DELETED'`);
        await q(`UPDATE "CrmContact" x SET "customer_id" = l.customer_id, "registered_at" = l.inscrit_le, "updated_at" = now()
                 FROM crm_lot l
                 WHERE x."id" = l.contact_id AND x."customer_id" IS NULL AND l.customer_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM "CrmContact" y WHERE y."customer_id" = l.customer_id)`);

        // Fiches du lot 1 (inscrit, inactif) jamais travaillées et entrées APRÈS la
        // première capture : ce sont des clients Glovo/Yango, requalifiés comme tels.
        const requalifieesIds = await tx.$queryRawUnsafe<{ id: string }[]>(`
          UPDATE "CrmContact" x
          SET "segment" = l.plateforme::"CrmSegment", "segment_since" = l.premier, "name" = coalesce(x."name", l.nom),
              "phone" = coalesce(x."phone", l.phone), "phone_key" = coalesce(x."phone_key", l.cle), "updated_at" = now()
          FROM crm_lot l
          WHERE x."id" = l.contact_id AND x."segment" IN ('JAMAIS_COMMANDE', 'INACTIF') AND x."segment_since" > l.premier
            AND x."cycle" = 1 AND x."status" = 'A_APPELER' AND x."call_count" = 0
            AND x."assigned_to_id" IS NULL AND x."campaign_id" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "CrmCall" k WHERE k."contact_id" = x."id")
            AND NOT EXISTS (SELECT 1 FROM "CrmCoupon" k WHERE k."contact_id" = x."id")
            AND (x."segment" = 'JAMAIS_COMMANDE' OR NOT EXISTS (
              SELECT 1 FROM "Order" o WHERE o."customer_id" = x."customer_id" AND ${EFFECTIVE}
                AND o."created_at" >= l.premier AND o."created_at" < x."segment_since"))
          RETURNING x."id"`);
        const requalifiees = requalifieesIds.length;

        // Les numéros sans fiche en reçoivent une. Pour un client qui a un compte,
        // ce qui est arrivé en premier donne le public (voir publicALaCapture) :
        // inscrit avant la capture sans commande, devenu inactif avant la
        // capture, sinon client Glovo/Yango. Jamais l'ordre des tâches.
        const INACTIF_LE = `(l.derniere + make_interval(days => $1::int))`;
        const INSCRIT_AVANT = `(l.customer_id IS NOT NULL AND l.derniere IS NULL AND l.inscrit_le < l.premier)`;
        const INACTIF_AVANT = `(l.customer_id IS NOT NULL AND l.derniere IS NOT NULL AND ${INACTIF_LE} < l.premier)`;
        const creees = await tx.$queryRawUnsafe<{ id: string; segment: string }[]>(
          `INSERT INTO "CrmContact" ("id", "customer_id", "phone", "phone_key", "name", "registered_at", "segment", "segment_since",
             "last_order_at", "updated_at")
           SELECT gen_random_uuid(), l.customer_id, l.phone, l.cle, l.nom, l.inscrit_le,
                  (CASE WHEN ${INSCRIT_AVANT} THEN 'JAMAIS_COMMANDE' WHEN ${INACTIF_AVANT} THEN 'INACTIF' ELSE l.plateforme END)::"CrmSegment",
                  CASE WHEN ${INSCRIT_AVANT} THEN l.inscrit_le WHEN ${INACTIF_AVANT} THEN ${INACTIF_LE} ELSE l.premier END,
                  l.derniere, now()
           FROM crm_lot l WHERE l.contact_id IS NULL
           ON CONFLICT DO NOTHING
           RETURNING "id", "segment"::text AS segment`,
          jours,
        );
        const fiches = creees.length;
        const horsCapture = creees.filter((c) => c.segment === 'JAMAIS_COMMANDE' || c.segment === 'INACTIF');
        if (horsCapture.length > 0) {
          await q(
            `INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
             SELECT gen_random_uuid(), x."id", 'ENTREE',
                    CASE x."segment" WHEN 'JAMAIS_COMMANDE' THEN 'Inscription sans commande' ELSE $2 END
             FROM "CrmContact" x WHERE x."id" = ANY($1::uuid[])`,
            horsCapture.map((c) => c.id),
            `Plus aucune commande depuis ${compter(jours, 'jour')}`,
          );
        }
        await q(`UPDATE crm_lot l SET contact_id = x."id" FROM "CrmContact" x
                 WHERE l.contact_id IS NULL AND (
                   (l.customer_id IS NOT NULL AND x."customer_id" = l.customer_id)
                   OR (l.customer_id IS NULL AND x."customer_id" IS NULL AND x."phone_key" = l.cle AND x."entity_status" <> 'DELETED'))`);
        // Entrée au journal pour les seules fiches Glovo/Yango que ce lot a créées
        // ou requalifiées : jamais pour une fiche déjà ouverte par une capture en direct.
        const entrees = [
          ...creees.filter((c) => c.segment === 'GLOVO' || c.segment === 'YANGO').map((c) => c.id),
          ...requalifieesIds.map((r) => r.id),
        ];
        if (entrees.length > 0) {
          await q(
            `INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label", "created_at")
             SELECT gen_random_uuid(), l.contact_id, 'ENTREE',
                    'Client ' || initcap(lower(l.plateforme)) || ' repris de l''acquisition', l.premier
             FROM crm_lot l
             WHERE l.contact_id = ANY($1::uuid[])
               AND NOT EXISTS (SELECT 1 FROM "CrmEvent" e WHERE e."contact_id" = l.contact_id AND e."type" = 'ENTREE'
                               AND e."label" LIKE 'Client % repris de l''acquisition')`,
            entrees,
          );
        }

        // Captures rattachées, et leur trace dans le journal.
        const captures = await q(`
          UPDATE "Prospect" p SET "contact_id" = l.contact_id
          FROM crm_lot l
          WHERE p."contact_id" IS NULL AND p."entity_status" <> 'DELETED' AND p."platform" IN ('GLOVO', 'YANGO')
            AND ${CLE_CAPTURE} = l.cle AND l.contact_id IS NOT NULL`);
        await q(`
          INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label", "data", "created_at")
          SELECT gen_random_uuid(), p."contact_id", 'CAPTURE',
                 left('Commande ' || initcap(lower(p."platform"::text)) || ' n° ' || p."order_number" || ' relevée à '
                      || coalesce(r."name", 'un restaurant'), 255),
                 jsonb_build_object('capture_id', p."id"), p."created_at"
          FROM "Prospect" p JOIN crm_lot l ON l.contact_id = p."contact_id"
          LEFT JOIN "Restaurant" r ON r."id" = p."restaurant_id"
          WHERE p."entity_status" <> 'DELETED' AND p."platform" IN ('GLOVO', 'YANGO')
            AND NOT EXISTS (SELECT 1 FROM "CrmEvent" e WHERE e."contact_id" = p."contact_id" AND e."type" = 'CAPTURE'
                            AND e."data"->>'capture_id' = p."id"::text)`);

        // Appels de l'acquisition, avec le public de la capture d'origine.
        const appels = await q(`
          INSERT INTO "CrmCall" ("id", "contact_id", "segment", "agent_id", "call_status_id", "status_label", "outcome",
                                 "reached", "attempt", "comment", "created_at", "prospect_call_id")
          SELECT gen_random_uuid(), p."contact_id", p."platform"::text::"CrmSegment", pc."agent_id", NULL,
                 CASE pc."result" WHEN 'JOINT' THEN 'Joint (acquisition)' WHEN 'NON_JOIGNABLE' THEN 'Non joignable (acquisition)'
                                  ELSE 'Refus (acquisition)' END,
                 (CASE pc."result" WHEN 'JOINT' THEN 'INTERESSE' WHEN 'NON_JOIGNABLE' THEN 'NON_JOINT'
                                   ELSE 'NON_INTERESSE' END)::"CrmCallOutcome",
                 pc."result" <> 'NON_JOIGNABLE', pc."rank", nullif(trim(pc."note"), ''), pc."created_at", pc."id"
          FROM "ProspectCall" pc
          JOIN "Prospect" p ON p."id" = pc."prospect_id"
          JOIN crm_lot l ON l.contact_id = p."contact_id"
          ON CONFLICT DO NOTHING`);

        // Coupons de l'acquisition : l'usage historique est posé tout de suite.
        const coupons = await q(`
          INSERT INTO "CrmCoupon" ("id", "contact_id", "segment", "promo_code_id", "code", "offer_label", "discount_type",
                                   "discount_value", "sent_at", "expires_at", "channel", "resent_count",
                                   "used_at", "order_id", "order_amount")
          SELECT gen_random_uuid(), p."contact_id", p."platform"::text::"CrmSegment", pc."id", pc."code",
                 left(CASE WHEN pc."discount_type" = 'PERCENTAGE'
                           THEN trim(to_char(pc."discount_value", 'FM999990.##')) || ' % de remise'
                           ELSE trim(to_char(pc."discount_value", 'FM9999999990')) || ' F de remise' END, 120),
                 pc."discount_type", pc."discount_value", coalesce(p."coupon_sent_at", pc."start_date"), pc."expiration_date",
                 'INCONNU', greatest((SELECT count(*) FROM "ProspectMessage" m WHERE m."prospect_id" = p."id") - 1, 0),
                 u."created_at", u."id", u."amount"
          FROM "Prospect" p
          JOIN crm_lot l ON l.contact_id = p."contact_id"
          JOIN "PromoCode" pc ON pc."id" = p."promo_code_id"
          LEFT JOIN LATERAL (
            SELECT o."id", o."created_at", o."amount" FROM "Order" o
            WHERE upper(trim(o."code_promo")) = upper(pc."code") AND ${EFFECTIVE}
            ORDER BY o."created_at" LIMIT 1
          ) u ON true
          ON CONFLICT DO NOTHING`);

        // Ventes historiques (avant la bascule), une par commande.
        const ventes = await q(
          `INSERT INTO "CrmConversion" ("id", "contact_id", "cycle", "segment", "order_id", "amount", "converted_at",
                                        "restaurant_id", "capture_id", "source")
           SELECT DISTINCT ON (p."first_order_id") gen_random_uuid(), p."contact_id", x."cycle", p."platform"::text::"CrmSegment",
                  p."first_order_id", coalesce(p."first_order_amount", o."amount"), p."converted_at", p."restaurant_id", p."id",
                  'ACQUISITION_HISTORIQUE'
           FROM "Prospect" p
           JOIN crm_lot l ON l.contact_id = p."contact_id"
           JOIN "CrmContact" x ON x."id" = p."contact_id"
           JOIN "Order" o ON o."id" = p."first_order_id" AND ${EFFECTIVE}
           WHERE p."status" = 'CONVERTI' AND p."converted_at" IS NOT NULL AND p."converted_at" < $1
           ORDER BY p."first_order_id", p."converted_at"
           ON CONFLICT DO NOTHING`,
          bascule,
        );

        // État de départ des fiches encore jamais travaillées dans le CRM.
        await q(`
          WITH conv AS (
            SELECT DISTINCT ON (p."contact_id") p."contact_id", p."converted_at", p."first_order_id", coalesce(p."first_order_amount", o."amount") AS montant
            FROM "Prospect" p JOIN crm_lot l ON l.contact_id = p."contact_id"
            JOIN "Order" o ON o."id" = p."first_order_id" AND ${EFFECTIVE}
            WHERE p."status" = 'CONVERTI' AND p."converted_at" IS NOT NULL
            ORDER BY p."contact_id", p."converted_at"
          )
          UPDATE "CrmContact" x
          SET "status" = 'CONVERTI', "converted_at" = c."converted_at", "conversion_order_id" = c."first_order_id",
              "conversion_amount" = c.montant, "callback_at" = NULL, "updated_at" = now()
          FROM conv c
          WHERE x."id" = c."contact_id" AND x."status" <> 'CONVERTI' AND x."segment" IN ('GLOVO', 'YANGO')
            AND x."assigned_to_id" IS NULL AND x."campaign_id" IS NULL
            AND x."segment_since" <= c."converted_at"`);
        await q(`
          WITH cible AS (
            SELECT x."id", x."segment_since" FROM "CrmContact" x JOIN crm_lot l ON l.contact_id = x."id"
            WHERE x."status" <> 'CONVERTI' AND x."assigned_to_id" IS NULL AND x."campaign_id" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "CrmCall" k WHERE k."contact_id" = x."id" AND k."prospect_call_id" IS NULL)
              AND NOT EXISTS (SELECT 1 FROM "CrmCoupon" k WHERE k."contact_id" = x."id"
                              AND NOT EXISTS (SELECT 1 FROM "Prospect" p WHERE p."promo_code_id" = k."promo_code_id"))
          ),
          appels AS (
            SELECT k."contact_id", count(*)::int AS n, max(k."created_at") AS dernier,
                   min(k."created_at") FILTER (WHERE k."reached") AS premier_joint
            FROM "CrmCall" k JOIN cible c ON c."id" = k."contact_id" WHERE k."created_at" >= c."segment_since"
            GROUP BY k."contact_id"
          ),
          dernier AS (
            SELECT DISTINCT ON (k."contact_id") k."contact_id", k."outcome", k."comment"
            FROM "CrmCall" k JOIN cible c ON c."id" = k."contact_id" WHERE k."created_at" >= c."segment_since"
            ORDER BY k."contact_id", k."created_at" DESC
          ),
          coupon AS (
            SELECT k."contact_id", max(k."sent_at") AS envoye FROM "CrmCoupon" k JOIN cible c ON c."id" = k."contact_id"
            WHERE k."used_at" IS NULL AND k."expires_at" > now() GROUP BY k."contact_id"
          )
          UPDATE "CrmContact" x
          SET "call_count" = coalesce(a.n, 0), "last_call_at" = a.dernier, "first_reached_at" = a.premier_joint,
              "last_call_outcome" = d."outcome", "last_comment" = d."comment",
              "qualified_at" = CASE WHEN d."outcome" IN ('INTERESSE', 'NON_INTERESSE') THEN a.dernier END,
              "coupon_sent_at" = coalesce(cp.envoye, x."coupon_sent_at"), "callback_at" = NULL,
              "status" = (CASE WHEN cp.envoye IS NOT NULL THEN 'COUPON_ENVOYE' WHEN d."outcome" = 'INTERESSE' THEN 'INTERESSE'
                               WHEN d."outcome" = 'NON_INTERESSE' THEN 'NON_INTERESSE' ELSE 'A_APPELER' END)::"CrmStatus",
              "updated_at" = now()
          FROM cible c LEFT JOIN appels a ON a."contact_id" = c."id" LEFT JOIN dernier d ON d."contact_id" = c."id"
          LEFT JOIN coupon cp ON cp."contact_id" = c."id"
          WHERE x."id" = c."id" AND (a.n IS NOT NULL OR cp.envoye IS NOT NULL)
            -- Revérifié sur la ligne verrouillée : une fiche prise, convertie ou
            -- mise en campagne pendant la reprise n'est pas écrasée.
            AND x."status" <> 'CONVERTI' AND x."assigned_to_id" IS NULL AND x."campaign_id" IS NULL`);

        return { fiches, requalifiees, captures, appels, coupons, ventes };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
  }
}
