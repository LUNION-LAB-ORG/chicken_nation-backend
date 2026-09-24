import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { COMMANDE_EFFECTIVE_SQL, NOUVEAU_CYCLE_SQL, compter } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';
import { CrmSyncService } from './crm-sync.service';

const EFFECTIVE = COMMANDE_EFFECTIVE_SQL;

/** Dernière commande effective de chaque client. */
const DERNIERES = `SELECT o."customer_id", max(o."created_at") AS derniere
  FROM "Order" o WHERE ${EFFECTIVE} GROUP BY o."customer_id"`;

/**
 * Traitements par lots du CRM, en SQL : ce que les événements ont pu manquer
 * (backend redémarré, base injoignable, commande modifiée par une route qui
 * n'émet rien), et le passage du temps, qu'aucun événement ne signale.
 */
@Injectable()
export class CrmRattrapageService {
  private readonly logger = new Logger(CrmRattrapageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
    private readonly sync: CrmSyncService,
  ) {}

  /** Toutes les 10 minutes : entrées, sorties et coupons manqués. */
  async reconcilier(): Promise<Record<string, number>> {
    const crees = await this.prisma.$executeRawUnsafe(`
      WITH nouveaux AS (
        INSERT INTO "CrmContact" ("id", "customer_id", "registered_at", "segment", "segment_since", "abandoned_orders", "updated_at")
        SELECT gen_random_uuid(), c."id", c."created_at", 'JAMAIS_COMMANDE', c."created_at",
               (SELECT count(*) FROM "Order" o WHERE o."customer_id" = c."id" AND o."entity_status" = 'DELETED'),
               now()
        FROM "Customer" c
        WHERE c."entity_status" <> 'DELETED'
          AND NOT EXISTS (SELECT 1 FROM "CrmContact" x WHERE x."customer_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."customer_id" = c."id" AND ${EFFECTIVE})
        ON CONFLICT ("customer_id") DO NOTHING
        RETURNING "id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), n."id", 'ENTREE', 'Inscription sans commande'
      FROM nouveaux n`);

    // Commande qui fait sortir : n'importe laquelle pour un inscrit, une
    // commande passée depuis l'entrée en inactivité pour un ancien client.
    const sortante = `EXISTS (SELECT 1 FROM "Order" o WHERE o."customer_id" = x."customer_id" AND ${EFFECTIVE}
      AND (x."segment" = 'JAMAIS_COMMANDE' OR o."created_at" >= x."segment_since"))`;
    const aRevoir = await this.prisma.$queryRawUnsafe<{ customer_id: string }[]>(`
      SELECT x."customer_id" FROM "CrmContact" x
      WHERE x."entity_status" <> 'DELETED' AND (
        (x."status" <> 'CONVERTI' AND ${sortante})
        OR (x."status" = 'CONVERTI' AND NOT ${sortante})
        OR EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = x."customer_id" AND c."entity_status" = 'DELETED')
      )
      LIMIT 500`);
    for (const { customer_id } of aRevoir) {
      await this.sync.synchroniserClient(customer_id).catch((e) =>
        this.logger.warn(`Réconciliation du client ${customer_id} échouée : ${(e as Error).message}`),
      );
    }

    const couponsUtilises = await this.prisma.$executeRawUnsafe(`
      UPDATE "CrmCoupon" cc
      SET "used_at" = o."created_at", "order_id" = o."id", "order_amount" = o."amount"
      FROM "Order" o
      WHERE cc."used_at" IS NULL
        AND upper(trim(o."code_promo")) = upper(cc."code")
        AND ${EFFECTIVE}`);

    const couponsLiberes = await this.prisma.$executeRawUnsafe(`
      UPDATE "CrmCoupon" cc
      SET "used_at" = NULL, "order_id" = NULL, "order_amount" = NULL
      FROM "Order" o
      WHERE cc."order_id" = o."id" AND o."entity_status" = 'DELETED'`);

    return { crees, revus: aRevoir.length, couponsUtilises, couponsLiberes };
  }

  /**
   * Chaque heure : les clients qui ont passé le délai sans commander
   * deviennent inactifs. Un client sans contact en reçoit un ; un client
   * converti ou reconquis qui a de nouveau décroché repart pour un cycle.
   * La date d'entrée est celle où le délai a été franchi, pas l'heure du
   * traitement : un historique repris garde ainsi ses vraies dates.
   */
  async detecterInactifs(): Promise<{ nouveaux: number; rechutes: number }> {
    const jours = await this.config.joursInactivite();
    const libelle = `Plus aucune commande depuis ${compter(jours, 'jour')}`;

    const nouveaux = await this.prisma.$executeRawUnsafe(
      `WITH d AS (${DERNIERES}),
      n AS (
        INSERT INTO "CrmContact" ("id", "customer_id", "registered_at", "segment", "segment_since", "last_order_at", "updated_at")
        SELECT gen_random_uuid(), c."id", c."created_at", 'INACTIF', d.derniere + make_interval(days => $1::int), d.derniere, now()
        FROM d JOIN "Customer" c ON c."id" = d."customer_id" AND c."entity_status" <> 'DELETED'
        WHERE d.derniere < now() - make_interval(days => $1::int)
          AND NOT EXISTS (SELECT 1 FROM "CrmContact" x WHERE x."customer_id" = c."id")
        ON CONFLICT ("customer_id") DO NOTHING
        RETURNING "id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), n."id", 'ENTREE', $2 FROM n`,
      jours,
      libelle,
    );

    const rechutes = await this.prisma.$executeRawUnsafe(
      `WITH d AS (${DERNIERES}),
      r AS (
        UPDATE "CrmContact" x
        SET ${NOUVEAU_CYCLE_SQL},
            "segment" = 'INACTIF',
            "segment_since" = d.derniere + make_interval(days => $1::int),
            "last_order_at" = d.derniere,
            "cycle" = x."cycle" + 1,
            "updated_at" = now()
        FROM d
        WHERE d."customer_id" = x."customer_id"
          AND x."status" = 'CONVERTI' AND x."entity_status" <> 'DELETED'
          AND d.derniere < now() - make_interval(days => $1::int)
        RETURNING x."id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), r."id", 'ENTREE', $2 FROM r`,
      jours,
      libelle,
    );

    return { nouveaux, rechutes };
  }
}
