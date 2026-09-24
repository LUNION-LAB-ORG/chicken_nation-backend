import { Injectable, Logger } from '@nestjs/common';
import {
  ConversionEventType,
  ConversionProspectStatus,
  ConversionReleaseReason,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { commandeEffective, statutSansConversion } from '../conversion.rules';
import { ConversionEventsService } from './conversion-events.service';

type CommandeVue = {
  id: string;
  reference: string;
  created_at: Date;
  amount: number;
  code_promo: string | null;
};

const SELECT_COMMANDE = {
  id: true,
  reference: true,
  created_at: true,
  amount: true,
  code_promo: true,
} satisfies Prisma.OrderSelect;

/**
 * Tient la population des prospects en accord avec la réalité des commandes.
 *
 * `synchroniserClient` est la seule porte d'entrée : elle relit le client en
 * base et en déduit l'état juste, quel que soit l'événement qui l'appelle.
 * Idempotente, elle peut tourner deux fois, en même temps, sur deux backends :
 * chaque écriture est un claim conditionné par l'état attendu.
 */
@Injectable()
export class ConversionSyncService {
  private readonly logger = new Logger(ConversionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ConversionEventsService,
  ) {}

  async synchroniserClient(customerId: string, commandeId?: string): Promise<void> {
    const [client, prospect, premiere] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, created_at: true, entity_status: true },
      }),
      this.prisma.conversionProspect.findUnique({
        where: { customer_id: customerId },
        select: {
          id: true,
          status: true,
          abandoned_orders: true,
          last_call_outcome: true,
          entity_status: true,
        },
      }),
      this.prisma.order.findFirst({
        where: commandeEffective(customerId),
        orderBy: { created_at: 'asc' },
        select: SELECT_COMMANDE,
      }),
    ]);
    if (!client) return;

    const abandons = await this.prisma.order.count({
      where: { customer_id: customerId, entity_status: EntityStatus.DELETED },
    });

    if (!prospect) {
      // Un client qui a déjà commandé n'a jamais été prospect.
      if (client.entity_status === EntityStatus.DELETED || premiere) return;
      await this.creer(client.id, client.created_at, abandons);
      return;
    }

    if (client.entity_status === EntityStatus.DELETED) {
      if (prospect.entity_status !== EntityStatus.DELETED) {
        await this.prisma.conversionProspect.update({
          where: { id: prospect.id },
          data: { entity_status: EntityStatus.DELETED },
        });
        this.events.signaler([prospect.id], 'client-supprime');
      }
      return;
    }

    if (prospect.abandoned_orders !== abandons) {
      await this.prisma.conversionProspect.update({
        where: { id: prospect.id },
        data: { abandoned_orders: abandons },
      });
    }

    if (premiere && prospect.status !== ConversionProspectStatus.CONVERTI) {
      await this.convertir(prospect.id, premiere);
    } else if (!premiere && prospect.status === ConversionProspectStatus.CONVERTI) {
      await this.retablir(prospect.id, prospect.last_call_outcome);
    }

    if (commandeId) await this.rattacherCoupon(commandeId);
  }

  private async creer(customerId: string, inscritLe: Date, abandons: number) {
    try {
      const cree = await this.prisma.conversionProspect.create({
        data: { customer_id: customerId, registered_at: inscritLe, abandoned_orders: abandons },
        select: { id: true },
      });
      await this.events.journaliser([
        { prospect_id: cree.id, type: ConversionEventType.ENTREE, label: 'Inscription sans commande' },
      ]);
      this.events.signaler([cree.id], 'entree');
    } catch (e) {
      // Deux backends ont vu la même inscription : le second perd, c'est voulu.
      if ((e as Prisma.PrismaClientKnownRequestError)?.code !== 'P2002') throw e;
    }
  }

  private async convertir(prospectId: string, commande: CommandeVue) {
    const claim = await this.prisma.conversionProspect.updateMany({
      where: { id: prospectId, status: { not: ConversionProspectStatus.CONVERTI } },
      data: {
        status: ConversionProspectStatus.CONVERTI,
        converted_at: commande.created_at,
        first_order_id: commande.id,
        first_order_amount: commande.amount,
        callback_at: null,
      },
    });
    if (claim.count === 0) return;

    await this.prisma.conversionCampaignMember.updateMany({
      where: { prospect_id: prospectId, released_at: null },
      data: {
        released_at: new Date(),
        release_reason: ConversionReleaseReason.CONVERTI,
        converted_at: commande.created_at,
      },
    });
    await this.events.journaliser([
      {
        prospect_id: prospectId,
        type: ConversionEventType.CONVERSION,
        label: `Première commande ${commande.reference} (${Math.round(commande.amount)} F)`,
        data: { order_id: commande.id, reference: commande.reference, amount: commande.amount },
      },
    ]);
    this.events.signaler([prospectId], 'conversion');
  }

  /** La seule commande a disparu (paiement abandonné) : il redevient prospect. */
  private async retablir(
    prospectId: string,
    dernierOutcome: Parameters<typeof statutSansConversion>[0]['last_call_outcome'],
  ) {
    const couponActif = await this.prisma.conversionCoupon.count({
      where: { prospect_id: prospectId, used_at: null, expires_at: { gt: new Date() } },
    });
    const claim = await this.prisma.conversionProspect.updateMany({
      where: { id: prospectId, status: ConversionProspectStatus.CONVERTI },
      data: {
        status: statutSansConversion({
          coupon_actif: couponActif > 0,
          last_call_outcome: dernierOutcome,
        }),
        converted_at: null,
        first_order_id: null,
        first_order_amount: null,
      },
    });
    if (claim.count === 0) return;

    await this.prisma.conversionCampaignMember.updateMany({
      where: {
        prospect_id: prospectId,
        release_reason: ConversionReleaseReason.CONVERTI,
        campaign: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
      },
      data: { released_at: null, release_reason: null, converted_at: null },
    });
    await this.events.journaliser([
      {
        prospect_id: prospectId,
        type: ConversionEventType.RETOUR,
        label: 'Commande supprimée : le client redevient prospect',
      },
    ]);
    this.events.signaler([prospectId], 'retour');
  }

  /** Un coupon de conversion utilisé sur une commande effective est rattaché. */
  async rattacherCoupon(commandeId: string): Promise<void> {
    const commande = await this.prisma.order.findFirst({
      where: { id: commandeId, ...commandeEffective() },
      select: SELECT_COMMANDE,
    });
    const code = commande?.code_promo?.trim();
    if (!commande || !code) return;
    await this.prisma.conversionCoupon.updateMany({
      where: { code: { equals: code, mode: 'insensitive' }, used_at: null },
      data: { used_at: commande.created_at, order_id: commande.id, order_amount: commande.amount },
    });
  }

  /**
   * Filet de sécurité : rattrape tout ce qu'un événement a pu manquer
   * (backend redémarré, base injoignable, commande modifiée par une route qui
   * n'émet rien). La définition du prospect est relue en SQL, pas déduite.
   */
  async reconcilier(): Promise<Record<string, number>> {
    const effective = `o."entity_status" <> 'DELETED'
      AND NOT (o."payment_method" = 'ONLINE' AND o."paied" = false AND o."status" = 'PENDING')`;

    const crees = await this.prisma.$executeRawUnsafe(`
      WITH nouveaux AS (
        INSERT INTO "ConversionProspect" ("id", "customer_id", "registered_at", "abandoned_orders", "updated_at")
        SELECT gen_random_uuid(), c."id", c."created_at",
               (SELECT count(*) FROM "Order" o WHERE o."customer_id" = c."id" AND o."entity_status" = 'DELETED'),
               now()
        FROM "Customer" c
        WHERE c."entity_status" <> 'DELETED'
          AND NOT EXISTS (SELECT 1 FROM "ConversionProspect" p WHERE p."customer_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."customer_id" = c."id" AND ${effective})
        ON CONFLICT ("customer_id") DO NOTHING
        RETURNING "id"
      )
      INSERT INTO "ConversionEvent" ("id", "prospect_id", "type", "label")
      SELECT gen_random_uuid(), n."id", 'ENTREE', 'Inscription sans commande'
      FROM nouveaux n`);

    const aRevoir = await this.prisma.$queryRawUnsafe<{ customer_id: string }[]>(`
      SELECT p."customer_id" FROM "ConversionProspect" p
      WHERE p."entity_status" <> 'DELETED' AND (
        (p."status" <> 'CONVERTI' AND EXISTS (SELECT 1 FROM "Order" o WHERE o."customer_id" = p."customer_id" AND ${effective}))
        OR (p."status" = 'CONVERTI' AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."customer_id" = p."customer_id" AND ${effective}))
        OR EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = p."customer_id" AND c."entity_status" = 'DELETED')
      )
      LIMIT 500`);
    for (const { customer_id } of aRevoir) {
      await this.synchroniserClient(customer_id).catch((e) =>
        this.logger.warn(`Réconciliation du client ${customer_id} échouée : ${(e as Error).message}`),
      );
    }

    const couponsUtilises = await this.prisma.$executeRawUnsafe(`
      UPDATE "ConversionCoupon" cc
      SET "used_at" = o."created_at", "order_id" = o."id", "order_amount" = o."amount"
      FROM "Order" o
      WHERE cc."used_at" IS NULL
        AND upper(trim(o."code_promo")) = upper(cc."code")
        AND ${effective}`);

    const couponsLiberes = await this.prisma.$executeRawUnsafe(`
      UPDATE "ConversionCoupon" cc
      SET "used_at" = NULL, "order_id" = NULL, "order_amount" = NULL
      FROM "Order" o
      WHERE cc."order_id" = o."id" AND o."entity_status" = 'DELETED'`);

    return { crees, revus: aRevoir.length, couponsUtilises, couponsLiberes };
  }
}
