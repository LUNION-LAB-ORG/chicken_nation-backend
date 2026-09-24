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
import { NOUVEAU_CYCLE, commandeEffective, compter, statutSansConversion } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';

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

type ContactVu = {
  id: string;
  status: CrmStatus;
  segment: CrmSegment;
  segment_since: Date;
  last_order_at: Date | null;
  abandoned_orders: number;
  last_call_outcome: Parameters<typeof statutSansConversion>[0]['last_call_outcome'];
  entity_status: EntityStatus;
};

const JOUR = 86_400_000;

/**
 * Tient les contacts du CRM en accord avec la réalité des commandes.
 *
 * Deux publics vivent ici :
 *  - l'inscrit sans commande, converti par sa première commande ;
 *  - l'ancien client inactif, reconquis par une commande passée après être
 *    devenu inactif. Un client converti ou reconquis qui ne commande plus
 *    pendant le délai réglé redevient inactif (nouveau cycle).
 *
 * `synchroniserClient` est la seule porte d'entrée : elle relit le client en
 * base et en déduit l'état juste, quel que soit l'événement qui l'appelle.
 * Idempotente, elle peut tourner deux fois, en même temps, sur deux backends :
 * chaque écriture est un claim conditionné par l'état attendu.
 */
@Injectable()
export class CrmSyncService {
  private readonly logger = new Logger(CrmSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
    private readonly events: CrmEventsService,
  ) {}

  async synchroniserClient(customerId: string, commandeId?: string): Promise<void> {
    const [client, contact, premiere, derniere, abandons, jours] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, created_at: true, entity_status: true },
      }),
      this.prisma.crmContact.findUnique({
        where: { customer_id: customerId },
        select: {
          id: true,
          status: true,
          segment: true,
          segment_since: true,
          last_order_at: true,
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
      this.prisma.order.findFirst({
        where: commandeEffective(customerId),
        orderBy: { created_at: 'desc' },
        select: SELECT_COMMANDE,
      }),
      this.prisma.order.count({
        where: { customer_id: customerId, entity_status: EntityStatus.DELETED },
      }),
      this.config.joursInactivite(),
    ]);
    if (!client) return;
    const inactif = !!derniere && derniere.created_at.getTime() < Date.now() - jours * JOUR;

    if (!contact) {
      if (client.entity_status === EntityStatus.DELETED) return;
      if (!premiere) await this.creer(client.id, client.created_at, abandons);
      else if (inactif) await this.creerInactif(client.id, client.created_at, derniere!, jours);
      if (commandeId) await this.rattacherCoupon(commandeId);
      return;
    }

    if (client.entity_status === EntityStatus.DELETED) {
      if (contact.entity_status !== EntityStatus.DELETED) {
        await this.prisma.crmContact.update({
          where: { id: contact.id },
          data: { entity_status: EntityStatus.DELETED },
        });
        this.events.signaler([contact.id], 'client-supprime');
      }
      return;
    }

    const derniereLe = derniere?.created_at ?? null;
    if (contact.abandoned_orders !== abandons || contact.last_order_at?.getTime() !== derniereLe?.getTime()) {
      await this.prisma.crmContact.update({
        where: { id: contact.id },
        data: { abandoned_orders: abandons, last_order_at: derniereLe },
      });
    }

    const conversion = await this.commandeDeConversion(contact, customerId, premiere);
    if (contact.status !== CrmStatus.CONVERTI) {
      if (conversion) await this.convertir(contact, conversion);
    } else if (!conversion) {
      await this.retablir(contact);
    } else if (inactif) {
      await this.rouvrirInactif(contact.id, derniere!, jours);
    }

    if (commandeId) await this.rattacherCoupon(commandeId);
  }

  /**
   * La commande qui fait sortir le contact de la liste : la toute première
   * pour un inscrit, la première passée depuis qu'il est devenu inactif pour
   * un ancien client.
   */
  private async commandeDeConversion(
    contact: Pick<ContactVu, 'segment' | 'segment_since'>,
    customerId: string,
    premiere: CommandeVue | null,
  ): Promise<CommandeVue | null> {
    if (contact.segment === CrmSegment.JAMAIS_COMMANDE) return premiere;
    return this.prisma.order.findFirst({
      where: { ...commandeEffective(customerId), created_at: { gte: contact.segment_since } },
      orderBy: { created_at: 'asc' },
      select: SELECT_COMMANDE,
    });
  }

  private async creer(customerId: string, inscritLe: Date, abandons: number) {
    await this.creerContact(
      {
        customer_id: customerId,
        registered_at: inscritLe,
        segment: CrmSegment.JAMAIS_COMMANDE,
        segment_since: inscritLe,
        abandoned_orders: abandons,
      },
      'Inscription sans commande',
    );
  }

  private async creerInactif(customerId: string, inscritLe: Date, derniere: CommandeVue, jours: number) {
    await this.creerContact(
      {
        customer_id: customerId,
        registered_at: inscritLe,
        segment: CrmSegment.INACTIF,
        segment_since: new Date(derniere.created_at.getTime() + jours * JOUR),
        last_order_at: derniere.created_at,
      },
      `Plus aucune commande depuis ${compter(jours, 'jour')}`,
    );
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

  private async convertir(contact: Pick<ContactVu, 'id' | 'segment'>, commande: CommandeVue) {
    const claim = await this.prisma.crmContact.updateMany({
      where: { id: contact.id, status: { not: CrmStatus.CONVERTI } },
      data: {
        status: CrmStatus.CONVERTI,
        converted_at: commande.created_at,
        conversion_order_id: commande.id,
        conversion_amount: commande.amount,
        callback_at: null,
      },
    });
    if (claim.count === 0) return;

    await this.prisma.crmCampaignMember.updateMany({
      where: { contact_id: contact.id, released_at: null },
      data: {
        released_at: new Date(),
        release_reason: CrmReleaseReason.CONVERTI,
        converted_at: commande.created_at,
      },
    });
    const quoi = contact.segment === CrmSegment.JAMAIS_COMMANDE ? 'Première commande' : 'Reconquis : commande';
    await this.events.journaliser([
      {
        contact_id: contact.id,
        type: CrmEventType.CONVERSION,
        label: `${quoi} ${commande.reference} (${Math.round(commande.amount)} F)`,
        data: { order_id: commande.id, reference: commande.reference, amount: commande.amount },
      },
    ]);
    this.events.signaler([contact.id], 'conversion');
  }

  /** La commande qui l'avait fait sortir a disparu : il revient dans la liste. */
  private async retablir(contact: Pick<ContactVu, 'id' | 'last_call_outcome'>) {
    const couponActif = await this.prisma.crmCoupon.count({
      where: { contact_id: contact.id, used_at: null, expires_at: { gt: new Date() } },
    });
    const claim = await this.prisma.crmContact.updateMany({
      where: { id: contact.id, status: CrmStatus.CONVERTI },
      data: {
        status: statutSansConversion({
          coupon_actif: couponActif > 0,
          last_call_outcome: contact.last_call_outcome,
        }),
        converted_at: null,
        conversion_order_id: null,
        conversion_amount: null,
      },
    });
    if (claim.count === 0) return;

    await this.prisma.crmCampaignMember.updateMany({
      where: {
        contact_id: contact.id,
        release_reason: CrmReleaseReason.CONVERTI,
        campaign: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
      },
      data: { released_at: null, release_reason: null, converted_at: null },
    });
    await this.events.journaliser([
      {
        contact_id: contact.id,
        type: CrmEventType.RETOUR,
        label: 'Commande supprimée : le client revient dans la liste',
      },
    ]);
    this.events.signaler([contact.id], 'retour');
  }

  /**
   * Un client converti ou reconquis qui ne commande plus redevient inactif.
   * L'historique reste ; le suivi (statut, agent, tentatives) repart à zéro.
   */
  private async rouvrirInactif(contactId: string, derniere: CommandeVue, jours: number) {
    const claim = await this.prisma.crmContact.updateMany({
      where: { id: contactId, status: CrmStatus.CONVERTI },
      data: {
        ...NOUVEAU_CYCLE,
        segment: CrmSegment.INACTIF,
        segment_since: new Date(derniere.created_at.getTime() + jours * JOUR),
        last_order_at: derniere.created_at,
        cycle: { increment: 1 },
      },
    });
    if (claim.count === 0) return;
    await this.events.journaliser([
      {
        contact_id: contactId,
        type: CrmEventType.ENTREE,
        label: `Plus aucune commande depuis ${compter(jours, 'jour')}`,
      },
    ]);
    this.events.signaler([contactId], 'entree');
  }

  /** Un coupon du CRM utilisé sur une commande effective est rattaché. */
  async rattacherCoupon(commandeId: string): Promise<void> {
    const commande = await this.prisma.order.findFirst({
      where: { id: commandeId, ...commandeEffective() },
      select: SELECT_COMMANDE,
    });
    const code = commande?.code_promo?.trim();
    if (!commande || !code) return;
    await this.prisma.crmCoupon.updateMany({
      where: { code: { equals: code, mode: 'insensitive' }, used_at: null },
      data: { used_at: commande.created_at, order_id: commande.id, order_amount: commande.amount },
    });
  }
}
