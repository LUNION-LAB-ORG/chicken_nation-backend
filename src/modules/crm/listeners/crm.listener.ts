import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Customer } from '@prisma/client';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import { CrmSyncService } from '../services/crm-sync.service';

type CommandeEmise = { id?: string; customer_id?: string } | undefined;

/**
 * Fait entrer un inscrit dans la population des contacts et l'en fait sortir
 * dès sa première commande, par n'importe quel canal (cahier §3).
 *
 * ⚠️ Aucun abonnement au succès KKiaPay : son émetteur attend TOUS ses
 * abonnés et relance le paiement si l'un échoue. Le paiement se voit ici par
 * le changement de statut de la commande qui le suit, et la réconciliation
 * périodique rattrape le reste.
 *
 * Chaque gestionnaire avale ses erreurs : un souci de suivi commercial ne doit
 * jamais faire échouer une inscription ou une commande.
 */
@Injectable()
export class CrmListener {
  private readonly logger = new Logger(CrmListener.name);

  constructor(private readonly sync: CrmSyncService) {}

  @OnEvent('customer.created')
  async inscription(payload: { customer: Customer }) {
    await this.synchroniser(payload?.customer?.id, undefined, 'inscription');
  }

  @OnEvent(OrderChannels.ORDER_CREATED)
  async commandeCreee(payload: { order?: CommandeEmise }) {
    await this.synchroniser(payload?.order?.customer_id, payload?.order?.id, 'création de commande');
  }

  @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
  async statutCommande(payload: { order?: CommandeEmise } & CommandeEmise) {
    const commande = payload?.order ?? payload;
    await this.synchroniser(commande?.customer_id, commande?.id, 'statut de commande');
  }

  @OnEvent(OrderChannels.ORDER_UPDATED)
  async commandeModifiee(payload: CommandeEmise) {
    await this.synchroniser(payload?.customer_id, payload?.id, 'modification de commande');
  }

  @OnEvent(OrderChannels.ORDER_DELETED)
  async commandeSupprimee(payload: CommandeEmise) {
    await this.synchroniser(payload?.customer_id, undefined, 'suppression de commande');
  }

  private async synchroniser(customerId: string | undefined, commandeId: string | undefined, origine: string) {
    if (!customerId) return;
    try {
      await this.sync.synchroniserClient(customerId, commandeId);
    } catch (e) {
      this.logger.warn(`Suivi contact (${origine}) du client ${customerId} échoué : ${(e as Error).message}`);
    }
  }
}
