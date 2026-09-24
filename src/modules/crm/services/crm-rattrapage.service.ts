import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { COLONNES_VENTE, COMMANDE_EFFECTIVE_SQL, NOUVEAU_CYCLE_SQL, compter, venteManquante } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';
import { CrmRegistreService } from './crm-registre.service';
import { CrmSyncService } from './crm-sync.service';

const EFFECTIVE = COMMANDE_EFFECTIVE_SQL;

/** Fiches rejugées au plus par passage de la réconciliation. */
export const TAILLE_REVUE = 500;

/** Dernière commande effective de chaque client. */
const DERNIERES = `SELECT o."customer_id", max(o."created_at") AS derniere
  FROM "Order" o WHERE ${EFFECTIVE} GROUP BY o."customer_id"`;

/** Clé à 10 chiffres d'un numéro de client, en SQL. */
const CLE_CLIENT = `right(regexp_replace(c."phone", '\\D', '', 'g'), 10)`;

/**
 * Client actif retenu pour chaque numéro : on écarte les comptes supprimés et
 * on préfère le format « + » (doublons historiques « 225… » / « +225… »).
 */
const ELUS = `SELECT DISTINCT ON (${CLE_CLIENT}) ${CLE_CLIENT} AS cle, c."id", c."created_at"
  FROM "Customer" c
  WHERE c."entity_status" <> 'DELETED' AND c."phone" IS NOT NULL
  ORDER BY ${CLE_CLIENT}, (c."phone" LIKE '+%') DESC, c."created_at", c."id"`;

/** Aucune fiche sans compte ne porte déjà ce numéro (sinon on la lie, jamais une seconde). */
const SANS_FICHE_DU_NUMERO = `NOT EXISTS (
  SELECT 1 FROM "CrmContact" y
  WHERE y."customer_id" IS NULL AND y."entity_status" <> 'DELETED' AND y."phone_key" = ${CLE_CLIENT})`;

/**
 * Traitements par lots du CRM, en SQL : ce que les événements ont pu manquer
 * (backend redémarré, base injoignable, commande modifiée par une route qui
 * n'émet rien, compte créé par la connexion OTP sans événement), et le passage
 * du temps, qu'aucun événement ne signale.
 */
@Injectable()
export class CrmRattrapageService {
  private readonly logger = new Logger(CrmRattrapageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
    private readonly sync: CrmSyncService,
    private readonly registre: CrmRegistreService,
  ) {}

  private bascule(): Promise<Date | null> {
    return this.registre.bascule();
  }

  /** Toutes les 10 minutes : coupons, comptes, entrées et sorties manqués. */
  async reconcilier(): Promise<Record<string, number>> {
    // 1. Coupons : utilisés ou libérés, AVANT de juger les fiches qui en dépendent.
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
    // Ventes d'une commande supprimée : annulées partout (source et cycle confondus).
    await this.prisma.$executeRawUnsafe(`
      UPDATE "CrmConversion" v SET "cancelled_at" = now()
      FROM "Order" o
      WHERE o."id" = v."order_id" AND o."entity_status" = 'DELETED' AND v."cancelled_at" IS NULL`);

    // 2. Comptes créés depuis (connexion OTP, site, caisse) : la fiche du numéro
    //    leur est rattachée. Un client par fiche, une fiche par client.
    const lies = await this.prisma.$executeRawUnsafe(`
      WITH elus AS (${ELUS}),
      paires AS (
        SELECT DISTINCT ON (e."id") x."id" AS contact_id, e."id" AS customer_id, e."created_at"
        FROM "CrmContact" x JOIN elus e ON e.cle = x."phone_key"
        WHERE x."customer_id" IS NULL AND x."entity_status" <> 'DELETED'
          AND NOT EXISTS (SELECT 1 FROM "CrmContact" y WHERE y."customer_id" = e."id")
        ORDER BY e."id", x."created_at"
      ),
      lies AS (
        UPDATE "CrmContact" x SET "customer_id" = p.customer_id, "registered_at" = p."created_at", "updated_at" = now()
        FROM paires p WHERE x."id" = p.contact_id AND x."customer_id" IS NULL
        RETURNING x."id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), l."id", 'INSCRIPTION', 'Compte sur l''application associé' FROM lies l`);

    // 3. Inscrits sans commande qui n'ont pas encore de fiche.
    const crees = await this.prisma.$executeRawUnsafe(`
      WITH nouveaux AS (
        INSERT INTO "CrmContact" ("id", "customer_id", "phone", "phone_key", "registered_at", "segment", "segment_since", "abandoned_orders", "updated_at")
        SELECT gen_random_uuid(), c."id", nullif(regexp_replace(c."phone", '\\D', '', 'g'), ''), ${CLE_CLIENT}, c."created_at",
               'JAMAIS_COMMANDE', c."created_at",
               (SELECT count(*) FROM "Order" o WHERE o."customer_id" = c."id" AND o."entity_status" = 'DELETED'),
               now()
        FROM "Customer" c
        WHERE c."entity_status" <> 'DELETED'
          AND NOT EXISTS (SELECT 1 FROM "CrmContact" x WHERE x."customer_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."customer_id" = c."id" AND ${EFFECTIVE})
          AND ${SANS_FICHE_DU_NUMERO}
        ON CONFLICT DO NOTHING
        RETURNING "id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), n."id", 'ENTREE', 'Inscription sans commande'
      FROM nouveaux n`);

    // 4. Fiches dont l'état ne correspond plus aux commandes : chacune est
    //    jugée seule, avec ou sans compte.
    const sortieParCompte = `x."customer_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Order" o WHERE o."customer_id" = x."customer_id" AND ${EFFECTIVE}
        AND (x."segment" = 'JAMAIS_COMMANDE' OR o."created_at" >= x."segment_since"))`;
    const sortieParCoupon = `EXISTS (
      SELECT 1 FROM "CrmCoupon" k JOIN "Order" o ON o."id" = k."order_id"
      WHERE k."contact_id" = x."id" AND ${EFFECTIVE}
        AND o."created_at" >= GREATEST(x."segment_since", k."sent_at"))`;
    const aRevoir = await this.prisma.$queryRawUnsafe<{ id: string }[]>(`
      SELECT x."id" FROM "CrmContact" x
      WHERE x."entity_status" <> 'DELETED' AND (
        (x."status" <> 'CONVERTI' AND ((${sortieParCompte}) OR ${sortieParCoupon}))
        OR (x."status" = 'CONVERTI' AND NOT EXISTS (
          SELECT 1 FROM "Order" o WHERE o."id" = x."conversion_order_id" AND ${EFFECTIVE}))
        OR (x."customer_id" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "Customer" c WHERE c."id" = x."customer_id" AND c."entity_status" = 'DELETED'))
      )
      ORDER BY x."updated_at"
      LIMIT ${TAILLE_REVUE}`);
    for (const { id } of aRevoir) {
      await this.sync.synchroniserContact(id).catch((e) =>
        this.logger.warn(`Réconciliation du contact ${id} échouée : ${(e as Error).message}`),
      );
    }

    // 5. Registre : toute fiche convertie par une commande qui n'est encore
    //    comptée nulle part y entre (une commande ne compte qu'une fois).
    const ventes = await this.prisma.$executeRawUnsafe(
      `INSERT INTO "CrmConversion" ${COLONNES_VENTE} ${venteManquante('$1')} ON CONFLICT DO NOTHING`,
      await this.bascule(),
    );

    return { crees, lies, revus: aRevoir.length, couponsUtilises, couponsLiberes, ventes };
  }

  /**
   * Chaque heure : les clients qui ont passé le délai sans commander
   * deviennent inactifs. Un client sans fiche en reçoit une (sauf si la fiche
   * de son numéro existe : le rattrapage la lui lie) ; un client converti ou
   * reconquis qui a de nouveau décroché repart pour un cycle. La date d'entrée
   * est celle où le délai a été franchi, pas l'heure du traitement.
   */
  async detecterInactifs(): Promise<{ nouveaux: number; rechutes: number }> {
    const jours = await this.config.joursInactivite();
    const libelle = `Plus aucune commande depuis ${compter(jours, 'jour')}`;

    const nouveaux = await this.prisma.$executeRawUnsafe(
      `WITH d AS (${DERNIERES}),
      n AS (
        INSERT INTO "CrmContact" ("id", "customer_id", "phone", "phone_key", "registered_at", "segment", "segment_since", "last_order_at", "updated_at")
        SELECT gen_random_uuid(), c."id", nullif(regexp_replace(c."phone", '\\D', '', 'g'), ''), ${CLE_CLIENT}, c."created_at",
               'INACTIF', d.derniere + make_interval(days => $1::int), d.derniere, now()
        FROM d JOIN "Customer" c ON c."id" = d."customer_id" AND c."entity_status" <> 'DELETED'
        WHERE d.derniere < now() - make_interval(days => $1::int)
          AND NOT EXISTS (SELECT 1 FROM "CrmContact" x WHERE x."customer_id" = c."id")
          AND ${SANS_FICHE_DU_NUMERO}
        ON CONFLICT DO NOTHING
        RETURNING "id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), n."id", 'ENTREE', $2 FROM n`,
      jours,
      libelle,
    );

    // Rechute mesurée depuis la plus récente de la dernière commande du compte
    // et de la conversion (qui a pu venir d'un autre compte, par un coupon).
    // Dans la MÊME requête, la vente du cycle qui se ferme entre au registre si
    // elle n'y est pas encore : le nouveau cycle efface la conversion de la fiche.
    const rechutes = await this.prisma.$executeRawUnsafe(
      `WITH d AS (${DERNIERES}),
      cibles AS (
        SELECT x."id" FROM "CrmContact" x JOIN d ON d."customer_id" = x."customer_id"
        WHERE x."status" = 'CONVERTI' AND x."entity_status" <> 'DELETED'
          AND GREATEST(d.derniere, x."converted_at") < now() - make_interval(days => $1::int)
      ),
      ventes AS (
        INSERT INTO "CrmConversion" ${COLONNES_VENTE}
        ${venteManquante('$3')} AND x."id" IN (SELECT "id" FROM cibles)
        ON CONFLICT DO NOTHING
      ),
      r AS (
        UPDATE "CrmContact" x
        SET ${NOUVEAU_CYCLE_SQL},
            "segment" = 'INACTIF',
            "segment_since" = GREATEST(d.derniere, x."converted_at") + make_interval(days => $1::int),
            "last_order_at" = d.derniere,
            "cycle" = x."cycle" + 1,
            "updated_at" = now()
        FROM d
        WHERE d."customer_id" = x."customer_id" AND x."id" IN (SELECT "id" FROM cibles) AND x."status" = 'CONVERTI'
        RETURNING x."id"
      )
      INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label")
      SELECT gen_random_uuid(), r."id", 'ENTREE', $2 FROM r`,
      jours,
      libelle,
      await this.bascule(),
    );

    return { nouveaux, rechutes };
  }
}
