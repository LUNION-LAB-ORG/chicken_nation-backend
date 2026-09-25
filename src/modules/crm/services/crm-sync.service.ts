import { Injectable, Logger } from '@nestjs/common';
import {
  CrmEventType,
  CrmReleaseReason,
  CrmSegment,
  CrmStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  COLONNES_VENTE,
  NOUVEAU_CYCLE,
  venteManquante,
  chiffresTelephone,
  cleTelephone,
  commandeEffective,
  compter,
  statutSansConversion,
} from '../crm.rules';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';
import { CrmIdentiteService } from './crm-identite.service';
import { CommandeCreditee, CrmRegistreService } from './crm-registre.service';

const SELECT_COMMANDE = {
  id: true,
  reference: true,
  created_at: true,
  amount: true,
  code_promo: true,
  restaurant_id: true,
} satisfies Prisma.OrderSelect;

const SELECT_CONTACT = {
  id: true,
  customer_id: true,
  status: true,
  segment: true,
  segment_since: true,
  cycle: true,
  last_order_at: true,
  abandoned_orders: true,
  last_call_outcome: true,
  conversion_order_id: true,
  converted_at: true,
  campaign_id: true,
  assigned_to_id: true,
  entity_status: true,
  customer: { select: { entity_status: true } },
} satisfies Prisma.CrmContactSelect;

type ContactVu = Prisma.CrmContactGetPayload<{ select: typeof SELECT_CONTACT }>;

const JOUR = 86_400_000;

/**
 * Tient les contacts du CRM en accord avec la réalité des commandes.
 *
 * Chaque fiche se décide seule (`synchroniserContact`), qu'elle ait un compte
 * sur l'application ou non :
 *  - la commande qui la fait sortir est la première commande effective de son
 *    compte (depuis son entrée dans le public, sauf pour un inscrit), ou une
 *    commande passée avec un de ses coupons, par n'importe quel compte ;
 *  - une fiche convertie le reste tant que SA commande est effective ;
 *  - un client converti qui ne commande plus pendant le délai réglé repart
 *    pour un cycle, en inactif (seulement s'il a un compte : sans compte, on
 *    ne voit pas ses commandes).
 * Idempotente et sûre en double backend : chaque écriture est un claim.
 */
@Injectable()
export class CrmSyncService {
  private readonly logger = new Logger(CrmSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
    private readonly events: CrmEventsService,
    private readonly identite: CrmIdentiteService,
    private readonly registre: CrmRegistreService,
  ) {}

  /** Porte d'entrée d'un client : lier ou créer sa fiche, puis la synchroniser. */
  async synchroniserClient(customerId: string, commandeId?: string): Promise<void> {
    const client = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, created_at: true, entity_status: true, phone: true },
    });
    if (!client) return;

    // Les coupons d'abord : une fiche rejugée doit voir son coupon rattaché,
    // ou rendu si la commande a été supprimée.
    if (commandeId) await this.rattacherCoupon(commandeId);
    const contactId = await this.identite.ficheDuClient(customerId);
    if (contactId) {
      await this.synchroniserContact(contactId);
    } else if (client.entity_status !== EntityStatus.DELETED) {
      await this.creerPourClient(client);
    }
  }

  /** Une commande a changé : les fiches qu'elle concerne, même sans compte. */
  async synchroniserCommande(commandeId: string, customerId?: string): Promise<void> {
    // Commande supprimée : ses ventes tombent partout, même d'un cycle passé
    // ou de l'historique d'acquisition, avant que les fiches soient rejugées.
    const supprimee = await this.prisma.order.count({ where: { id: commandeId, entity_status: EntityStatus.DELETED } });
    if (supprimee > 0) await this.registre.annulerCommande(commandeId, this.prisma);
    if (customerId) await this.synchroniserClient(customerId, commandeId);
    else await this.rattacherCoupon(commandeId);
    const liees = await this.prisma.crmContact.findMany({
      where: {
        OR: [{ conversion_order_id: commandeId }, { coupons: { some: { order_id: commandeId } } }],
      },
      select: { id: true },
    });
    for (const { id } of liees) await this.synchroniserContact(id);
  }

  async synchroniserContact(contactId: string): Promise<void> {
    const c = await this.prisma.crmContact.findUnique({ where: { id: contactId }, select: SELECT_CONTACT });
    if (!c || c.entity_status === EntityStatus.DELETED) return;

    if (c.customer?.entity_status === EntityStatus.DELETED) {
      await this.prisma.crmContact.update({ where: { id: c.id }, data: { entity_status: EntityStatus.DELETED } });
      this.events.signaler([c.id], 'client-supprime');
      return;
    }

    const [jours, derniere] = await Promise.all([
      this.config.joursInactivite(),
      c.customer_id
        ? this.prisma.order.findFirst({
            where: commandeEffective(c.customer_id),
            orderBy: { created_at: 'desc' },
            select: SELECT_COMMANDE,
          })
        : null,
    ]);
    if (c.customer_id) await this.entretenir(c, derniere?.created_at ?? null);

    const candidate = await this.commandeCandidate(c);
    if (c.status !== CrmStatus.CONVERTI) {
      if (candidate) await this.convertir(c, candidate);
      return;
    }

    const actuelle = c.conversion_order_id
      ? await this.prisma.order.findFirst({ where: { id: c.conversion_order_id, ...commandeEffective() }, select: SELECT_COMMANDE })
      : null;
    if (!actuelle) {
      if (candidate) await this.remplacerConversion(c, candidate);
      else await this.retablir(c);
      return;
    }

    // Rechute : mesurée depuis la dernière commande du compte (ou la conversion,
    // si elle est plus récente, par exemple une commande d'un autre compte).
    if (c.customer_id) {
      const repere = Math.max(derniere?.created_at.getTime() ?? 0, c.converted_at?.getTime() ?? 0);
      if (repere > 0 && repere < Date.now() - jours * JOUR) await this.rouvrirInactif(c.id, new Date(repere), jours);
    }
  }

  /** Abandons de paiement et dernière commande, recopiés pour trier et filtrer. */
  private async entretenir(c: ContactVu, derniereLe: Date | null) {
    const abandons = await this.prisma.order.count({
      where: { customer_id: c.customer_id!, entity_status: EntityStatus.DELETED },
    });
    if (c.abandoned_orders !== abandons || c.last_order_at?.getTime() !== derniereLe?.getTime()) {
      await this.prisma.crmContact.update({
        where: { id: c.id },
        data: { abandoned_orders: abandons, last_order_at: derniereLe },
      });
    }
  }

  /**
   * La commande qui fait sortir la fiche : la plus ancienne entre la première
   * commande de son compte (depuis son entrée, sauf pour un inscrit) et une
   * commande passée avec l'un de ses coupons après son envoi.
   */
  private async commandeCandidate(c: ContactVu): Promise<CommandeCreditee | null> {
    const [parCompte, parCoupon] = await Promise.all([
      c.customer_id
        ? this.prisma.order.findFirst({
            where: {
              ...commandeEffective(c.customer_id),
              ...(c.segment !== CrmSegment.JAMAIS_COMMANDE && { created_at: { gte: c.segment_since } }),
            },
            orderBy: { created_at: 'asc' },
            select: SELECT_COMMANDE,
          })
        : null,
      this.prisma.$queryRaw<CommandeCreditee[]>`
        SELECT o."id", o."reference", o."created_at", o."amount", o."code_promo", o."restaurant_id"
        FROM "CrmCoupon" k
        JOIN "Order" o ON upper(trim(o."code_promo")) = upper(k."code")
        WHERE k."contact_id" = ${c.id}::uuid
          AND o."entity_status" <> 'DELETED'
          AND NOT (o."payment_method" = 'ONLINE' AND o."paied" = false AND o."status" = 'PENDING')
          AND o."created_at" >= GREATEST(${c.segment_since}, k."sent_at")
        ORDER BY o."created_at" ASC
        LIMIT 1`.then((l) => l[0] ?? null),
    ]);
    if (!parCompte) return parCoupon;
    if (!parCoupon) return parCompte;
    return parCoupon.created_at < parCompte.created_at ? parCoupon : parCompte;
  }

  /** Création de la fiche d'un client qui n'en a pas : inscrit sans commande, ou inactif. */
  private async creerPourClient(client: { id: string; created_at: Date; phone: string | null }) {
    const [premiere, derniere, abandons, jours] = await Promise.all([
      this.prisma.order.findFirst({ where: commandeEffective(client.id), orderBy: { created_at: 'asc' }, select: { id: true } }),
      this.prisma.order.findFirst({ where: commandeEffective(client.id), orderBy: { created_at: 'desc' }, select: { created_at: true } }),
      this.prisma.order.count({ where: { customer_id: client.id, entity_status: EntityStatus.DELETED } }),
      this.config.joursInactivite(),
    ]);
    const telephone = { phone: chiffresTelephone(client.phone) || null, phone_key: cleTelephone(client.phone) };
    if (!premiere) {
      await this.creerContact(
        {
          customer_id: client.id,
          ...telephone,
          registered_at: client.created_at,
          segment: CrmSegment.JAMAIS_COMMANDE,
          segment_since: client.created_at,
          abandoned_orders: abandons,
        },
        'Inscription sans commande',
      );
    } else if (derniere && derniere.created_at.getTime() < Date.now() - jours * JOUR) {
      await this.creerContact(
        {
          customer_id: client.id,
          ...telephone,
          registered_at: client.created_at,
          segment: CrmSegment.INACTIF,
          segment_since: new Date(derniere.created_at.getTime() + jours * JOUR),
          last_order_at: derniere.created_at,
        },
        `Plus aucune commande depuis ${compter(jours, 'jour')}`,
      );
    }
  }

  private async creerContact(data: Prisma.CrmContactUncheckedCreateInput, libelle: string) {
    try {
      const cree = await this.prisma.crmContact.create({ data, select: { id: true } });
      await this.events.journaliser([{ contact_id: cree.id, type: CrmEventType.ENTREE, label: libelle }]);
      this.events.signaler([cree.id], 'entree');
    } catch (e) {
      // Deux backends ont vu le même client : le second perd, c'est voulu.
      if ((e as Prisma.PrismaClientKnownRequestError)?.code !== 'P2002') throw e;
    }
  }

  private async convertir(c: ContactVu, commande: CommandeCreditee) {
    const converti = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.crmContact.updateMany({
        where: { id: c.id, status: { not: CrmStatus.CONVERTI } },
        data: {
          status: CrmStatus.CONVERTI,
          converted_at: commande.created_at,
          conversion_order_id: commande.id,
          conversion_amount: commande.amount,
          callback_at: null,
        },
      });
      if (claim.count === 0) return false;
      await this.registre.crediter(tx, c, commande);
      await tx.crmCampaignMember.updateMany({
        where: { contact_id: c.id, released_at: null },
        data: { released_at: new Date(), release_reason: CrmReleaseReason.CONVERTI, converted_at: commande.created_at },
      });
      const quoi =
        c.segment === CrmSegment.JAMAIS_COMMANDE ? 'Première commande' : c.segment === CrmSegment.INACTIF ? 'Reconquis : commande' : 'Commande directe';
      const code = commande.code_promo?.trim();
      const avecCoupon =
        !!code && (await tx.crmCoupon.count({ where: { contact_id: c.id, code: { equals: code, mode: 'insensitive' } } })) > 0;
      await this.events.journaliser(
        [
          {
            contact_id: c.id,
            type: CrmEventType.CONVERSION,
            label: `${quoi} ${commande.reference} (${Math.round(commande.amount)} F)${avecCoupon ? ` avec le coupon ${code!.toUpperCase()}` : ''}`,
            data: { order_id: commande.id, reference: commande.reference, amount: commande.amount },
          },
        ],
        tx,
      );
      return true;
    });
    if (converti) this.events.signaler([c.id], 'conversion');
  }

  /** Sa commande n'est plus effective, mais une autre la remplace : on change en silence. */
  private async remplacerConversion(c: ContactVu, commande: CommandeCreditee) {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.crmContact.updateMany({
        where: { id: c.id, status: CrmStatus.CONVERTI, conversion_order_id: c.conversion_order_id },
        data: { converted_at: commande.created_at, conversion_order_id: commande.id, conversion_amount: commande.amount },
      });
      if (claim.count === 0) return;
      await this.registre.annuler(tx, c.id, c.cycle, c.conversion_order_id);
      await this.registre.crediter(tx, c, commande);
    });
  }

  /** La commande qui l'avait fait sortir a disparu : il revient dans la liste. */
  private async retablir(c: ContactVu) {
    const [couponActif, campagne] = await Promise.all([
      this.prisma.crmCoupon.count({ where: { contact_id: c.id, used_at: null, expires_at: { gt: new Date() } } }),
      c.campaign_id ? this.prisma.crmCampaign.findUnique({ where: { id: c.campaign_id }, select: { status: true } }) : null,
    ]);
    // Revenu dans la liste après la fin de sa campagne : il la quitte, pour
    // retrouver la file de son agent (ou la file commune s'il n'en a plus).
    const campagneFinie = !!campagne && campagne.status !== 'ACTIVE' && campagne.status !== 'SUSPENDED';
    const retabli = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.crmContact.updateMany({
        where: { id: c.id, status: CrmStatus.CONVERTI },
        data: {
          status: statutSansConversion({ coupon_actif: couponActif > 0, last_call_outcome: c.last_call_outcome }),
          converted_at: null,
          conversion_order_id: null,
          conversion_amount: null,
          ...(campagneFinie && { campaign_id: null }),
        },
      });
      if (claim.count === 0) return false;
      await this.registre.annuler(tx, c.id, c.cycle, c.conversion_order_id);
      await tx.crmCampaignMember.updateMany({
        where: {
          contact_id: c.id,
          release_reason: CrmReleaseReason.CONVERTI,
          campaign: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
        },
        data: { released_at: null, release_reason: null, converted_at: null },
      });
      await this.events.journaliser(
        [{ contact_id: c.id, type: CrmEventType.RETOUR, label: 'Commande supprimée : le client revient dans la liste' }],
        tx,
      );
      return true;
    });
    if (retabli) this.events.signaler([c.id], 'retour');
  }

  /**
   * Un client converti ou reconquis qui ne commande plus redevient inactif.
   * L'historique et le registre des ventes restent ; le suivi repart à zéro.
   */
  private async rouvrirInactif(contactId: string, repere: Date, jours: number) {
    const bascule = await this.registre.bascule();
    const claim = await this.prisma.$transaction(async (tx) => {
      // La vente du cycle qui se ferme entre au registre si elle n'y est pas :
      // le nouveau cycle efface la conversion de la fiche.
      await tx.$executeRawUnsafe(
        `INSERT INTO "CrmConversion" ${COLONNES_VENTE} ${venteManquante('$1')} AND x."id" = $2::uuid ON CONFLICT DO NOTHING`,
        bascule,
        contactId,
      );
      return tx.crmContact.updateMany({
        where: { id: contactId, status: CrmStatus.CONVERTI },
        data: {
          ...NOUVEAU_CYCLE,
          segment: CrmSegment.INACTIF,
          segment_since: new Date(repere.getTime() + jours * JOUR),
          last_order_at: repere,
          cycle: { increment: 1 },
        },
      });
    });
    if (claim.count === 0) return;
    await this.events.journaliser([
      { contact_id: contactId, type: CrmEventType.ENTREE, label: `Plus aucune commande depuis ${compter(jours, 'jour')}` },
    ]);
    this.events.signaler([contactId], 'entree');
  }

  /**
   * Un coupon du CRM utilisé sur une commande effective est rattaché, puis sa
   * fiche est synchronisée : elle sort de la liste même si la commande vient
   * d'un autre compte (règle du code promo de l'acquisition). Une commande
   * supprimée rend au contraire ses coupons, avant que leurs fiches ne soient
   * rejugées : sans cela, la fiche perdrait son statut « coupon envoyé ».
   */
  async rattacherCoupon(commandeId: string): Promise<void> {
    const supprimee = await this.prisma.order.count({
      where: { id: commandeId, entity_status: EntityStatus.DELETED },
    });
    if (supprimee > 0) {
      const rendus = await this.prisma.crmCoupon.findMany({
        where: { order_id: commandeId },
        select: { id: true, contact_id: true },
      });
      if (rendus.length === 0) return;
      await this.prisma.crmCoupon.updateMany({
        where: { id: { in: rendus.map((k) => k.id) }, order_id: commandeId },
        data: { used_at: null, order_id: null, order_amount: null },
      });
      for (const k of rendus) await this.synchroniserContact(k.contact_id);
      return;
    }

    const commande = await this.prisma.order.findFirst({
      where: { id: commandeId, ...commandeEffective() },
      select: SELECT_COMMANDE,
    });
    const code = commande?.code_promo?.trim();
    if (!commande || !code) return;
    const coupons = await this.prisma.crmCoupon.findMany({
      where: { code: { equals: code, mode: 'insensitive' }, OR: [{ used_at: null }, { order_id: commande.id }] },
      select: { id: true, contact_id: true, used_at: true },
    });
    for (const k of coupons) {
      if (!k.used_at) {
        await this.prisma.crmCoupon.updateMany({
          where: { id: k.id, used_at: null },
          data: { used_at: commande.created_at, order_id: commande.id, order_amount: commande.amount },
        });
      }
      await this.synchroniserContact(k.contact_id);
    }
  }
}
