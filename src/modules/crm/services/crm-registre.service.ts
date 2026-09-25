import { Injectable } from '@nestjs/common';
import { CrmConversionSource, CrmEventType, CrmSegment, Prisma } from '@prisma/client';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CRM_SETTINGS } from '../crm.rules';
import { CrmEventsService } from './crm-events.service';

type Tx = Prisma.TransactionClient;

export interface ContactCredite {
  id: string;
  cycle: number;
  segment: CrmSegment;
  /** Entrée dans le passage en cours : une capture plus ancienne appartient à un passage fini. */
  segment_since: Date;
  campaign_id: string | null;
  assigned_to_id: string | null;
}

export interface CommandeCreditee {
  id: string;
  reference: string;
  amount: number;
  created_at: Date;
  code_promo: string | null;
  restaurant_id: string | null;
}

/**
 * Registre des ventes du CRM. Une commande ne compte qu'une fois : une
 * personne avec deux puces (compte appli sur l'une, commandes Glovo sur
 * l'autre) peut sortir de deux fiches par la même commande, mais la vente et
 * son chiffre d'affaires ne sont comptés qu'une fois. Et une vente passée
 * reste acquise quand le client redevient inactif : les fiches se remettent à
 * zéro à chaque cycle, pas le registre.
 */
@Injectable()
export class CrmRegistreService {
  constructor(
    private readonly events: CrmEventsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Source d'une vente : une commande d'un client Glovo/Yango passée avant la
   * bascule appartient à l'ancienne acquisition (« historique »), jamais au CRM.
   */
  async source(segment: CrmSegment, commandeLe: Date): Promise<CrmConversionSource> {
    if (segment !== CrmSegment.GLOVO && segment !== CrmSegment.YANGO) return CrmConversionSource.CRM;
    const bascule = await this.bascule();
    return bascule && commandeLe < bascule ? CrmConversionSource.ACQUISITION_HISTORIQUE : CrmConversionSource.CRM;
  }

  /** Jour où le CRM a pris le relais de l'ancienne acquisition Glovo/Yango. */
  async bascule(): Promise<Date | null> {
    const v = await this.settings.get(CRM_SETTINGS.BASCULE_ACQUISITION);
    return v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null;
  }

  /**
   * Crédite la vente au contact qui vient de sortir de la liste. Déjà créditée
   * à une autre fiche : la fiche qui a envoyé le coupon utilisé l'emporte,
   * sinon la vente reste à la première. Renvoie vrai si ce contact la porte.
   */
  async crediter(tx: Tx, contact: ContactCredite, commande: CommandeCreditee): Promise<boolean> {
    const existante = await tx.crmConversion.findFirst({
      where: { order_id: commande.id, cancelled_at: null },
      select: { id: true, contact_id: true, source: true },
    });
    if (existante) {
      if (existante.contact_id === contact.id) return true;
      const code = commande.code_promo?.trim();
      const couponDe = async (contactId: string) =>
        !!code && (await tx.crmCoupon.count({ where: { contact_id: contactId, code: { equals: code, mode: 'insensitive' } } })) > 0;
      if (existante.source === CrmConversionSource.CRM && (await couponDe(contact.id)) && !(await couponDe(existante.contact_id))) {
        const capture = await this.captureDuPassage(tx, contact, commande);
        const campagne = await this.campagneDeLaVente(tx, contact, commande);
        await tx.crmConversion.update({
          where: { id: existante.id },
          data: {
            contact_id: contact.id,
            cycle: contact.cycle,
            segment: contact.segment,
            capture_id: capture,
            campaign_id: campagne,
            agent_id: contact.assigned_to_id,
          },
        });
        await this.events.journaliser(
          [
            {
              contact_id: existante.contact_id,
              type: CrmEventType.CONVERSION,
              label: `Vente ${commande.reference} comptée pour la fiche qui avait envoyé le coupon`,
            },
          ],
          tx,
        );
        return true;
      }
      await this.events.journaliser(
        [{ contact_id: contact.id, type: CrmEventType.CONVERSION, label: `Commande ${commande.reference} déjà comptée pour une autre fiche` }],
        tx,
      );
      return false;
    }

    const source = await this.source(contact.segment, commande.created_at);
    const capture = await this.captureDuPassage(tx, contact, commande);
    const campagne = await this.campagneDeLaVente(tx, contact, commande);
    const inseres = await tx.$executeRaw`
      INSERT INTO "CrmConversion" ("id", "contact_id", "cycle", "segment", "order_id", "amount", "converted_at",
        "restaurant_id", "capture_id", "campaign_id", "agent_id", "source")
      VALUES (gen_random_uuid(), ${contact.id}::uuid, ${contact.cycle}, ${contact.segment}::"CrmSegment",
        ${commande.id}::uuid, ${commande.amount}, ${commande.created_at}, ${commande.restaurant_id}::uuid,
        ${capture}::uuid, ${campagne}::uuid, ${contact.assigned_to_id}::uuid, ${source}::"CrmConversionSource")
      ON CONFLICT DO NOTHING`;
    return inseres > 0;
  }

  /**
   * Campagne créditée : celle du coupon utilisé s'il vient d'une campagne (le
   * client gardé par son agent à la clôture commande souvent après), sinon la
   * campagne en cours de la fiche.
   */
  private async campagneDeLaVente(tx: Tx, contact: ContactCredite, commande: CommandeCreditee): Promise<string | null> {
    const code = commande.code_promo?.trim();
    if (code) {
      const coupon = await tx.crmCoupon.findFirst({
        where: { contact_id: contact.id, code: { equals: code, mode: 'insensitive' }, campaign_id: { not: null } },
        select: { campaign_id: true },
      });
      if (coupon?.campaign_id) return coupon.campaign_id;
    }
    return contact.campaign_id;
  }

  /**
   * Capture à l'origine d'une vente : la plus récente capture du passage en
   * cours faite avant la commande. Une capture d'un passage fini, ou
   * postérieure à la commande, n'y est pour rien.
   */
  private async captureDuPassage(tx: Tx, contact: ContactCredite, commande: CommandeCreditee): Promise<string | null> {
    const [capture] = await tx.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "Prospect" p
      WHERE p."contact_id" = ${contact.id}::uuid AND p."entity_status" <> 'DELETED'
        AND p."created_at" <= ${commande.created_at} AND p."created_at" >= ${contact.segment_since}
      ORDER BY p."created_at" DESC LIMIT 1`;
    return capture?.id ?? null;
  }

  /**
   * La commande qui avait fait sortir le contact n'est plus effective : sa
   * vente est annulée, qu'elle soit du CRM ou de l'historique d'acquisition.
   */
  async annuler(tx: Tx, contactId: string, cycle: number, commandeId: string | null): Promise<void> {
    await tx.crmConversion.updateMany({
      where: {
        contact_id: contactId,
        cycle,
        cancelled_at: null,
        OR: [{ source: CrmConversionSource.CRM }, ...(commandeId ? [{ order_id: commandeId }] : [])],
      },
      data: { cancelled_at: new Date() },
    });
  }

  /** Commande supprimée : toutes ses ventes tombent, quels que soient la source et le cycle. */
  async annulerCommande(commandeId: string, client: Pick<Tx, 'crmConversion'>): Promise<number> {
    const r = await client.crmConversion.updateMany({
      where: { order_id: commandeId, cancelled_at: null },
      data: { cancelled_at: new Date() },
    });
    return r.count;
  }
}
