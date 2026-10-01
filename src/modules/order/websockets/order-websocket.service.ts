import { sanitizeOrderForBroadcast } from 'src/common/utils/order-broadcast.util';
import { Injectable } from '@nestjs/common';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { Order, OrderStatus } from '@prisma/client';
import { OrderChannels } from '../enums/order-channels';
import { sansIdentifiantsPush } from '../helpers/identifiants-push.helper';
import { estBrouillon, estPanierAnnuleParClient } from '../helpers/brouillons.rules';

/**
 * Ce qu'un brouillon (panier de l'application non payé) laisse voir au back
 * office : de quoi relire ses listes, rien de plus. Ni nom, ni téléphone, ni
 * adresse, ni client : `backoffice_all` réunit aussi le marketing et la
 * comptabilité, qui ne suivent pas les paniers non payés.
 */
function chargeBrouillon(order: Order) {
    return {
        id: order.id,
        status: order.status,
        auto: order.auto,
        restaurant_id: order.restaurant_id,
        created_at: order.created_at,
    };
}

/**
 * Changement de statut d'un panier que le restaurant n'a jamais vu.
 *
 * Évalué sur l'état PRÉCÉDENT (en attente, de l'application, non payé, en
 * ligne) : après le changement, la commande n'est plus en attente et la règle
 * ne la reconnaîtrait plus. Un panier payé (`paied`) ou repris au téléphone
 * (`auto` à faux) n'est plus un brouillon : le restaurant le reçoit.
 *
 * ⚠️ Reste hors du restaurant tant que le panier ne devient pas une commande à
 * préparer : annulé ou toujours en attente. Accepté (ou plus loin) par le
 * personnel sans bascule, il entre dans la liste du restaurant (qui montre
 * les commandes de l'application dès qu'elles ne sont plus en attente) : la
 * caisse doit alors le recevoir en temps réel, comme la cloche le lui annonce.
 */
function resteHorsDuRestaurant(order: Order, previousStatus: OrderStatus): boolean {
    // Panier annulé par le client (01/10) : supprimé des listes, donc plus un
    // brouillon au sens strict, mais le restaurant ne l'a jamais vu.
    if (estPanierAnnuleParClient(order)) return true;
    return (
        estBrouillon({ ...order, status: previousStatus }) &&
        (order.status === OrderStatus.PENDING || order.status === OrderStatus.CANCELLED)
    );
}

/**
 * Aucune commande ne part sur un socket avec un identifiant de notification
 * (jeton Expo, identifiants OneSignal), pas même vers le client : chaque
 * méthode commence par `sansIdentifiantsPush`. Le code de récupération, lui,
 * n'est retiré que des diffusions au restaurant et au back office.
 *
 * BROUILLONS (décision 4 de la relance des commandes en attente) : les
 * restaurants ne voient pas les paniers non payés. Un brouillon (`estBrouillon`,
 * même règle que la liste des commandes) ne part JAMAIS vers la salle du
 * restaurant, et le back office n'en reçoit qu'une charge réduite. Le client,
 * lui, reçoit toujours sa commande entière sur son canal privé.
 */
@Injectable()
export class OrderWebSocketService {
    constructor(private appGateway: AppGateway) { }

    /**
     * @param options.brouillon  Posé par la seule création de l'application
     *   (`OrderService.createv2`), d'après `estBrouillon`. Jamais déduit ici :
     *   l'appel du paiement (`KkiapayOrderListenerService`) passe la commande
     *   telle qu'elle était AVANT le paiement (en attente, non payée), et la
     *   caisse doit continuer à la recevoir.
     */
    emitOrderCreated(commande: Order, options: { brouillon?: boolean } = {}) {
        const order = sansIdentifiantsPush(commande);
        // Notifier le client qui a passé la commande
        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_CREATED, {
            order,
            message: 'Votre commande a été créée avec succès'
        });

        if (options.brouillon) {
            // Le back office n'en fait qu'une relecture de ses listes.
            this.appGateway.emitToBackoffice(OrderChannels.ORDER_CREATED, {
                order: chargeBrouillon(order),
                message: 'Nouvelle commande reçue'
            });
            return;
        }

        // Notifier le backoffice
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_CREATED, {
            order: sanitizeOrderForBroadcast(order),
            message: 'Nouvelle commande reçue'
        });

        // Notifier le restaurant
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_CREATED, {
            order: sanitizeOrderForBroadcast(order),
            message: 'Nouvelle commande pour votre restaurant'
        });
    }

    emitStatusUpdate(commande: Order, previousStatus: OrderStatus) {
        const order = sansIdentifiantsPush(commande);
        const statusMessages = {
            PENDING: 'Commande en attente',
            ACCEPTED: 'Commande confirmée',
            IN_PROGRESS: 'Commande en préparation',
            READY: 'Commande prête',
            PICKED_UP: 'Commande en livraison',
            COLLECTED: 'Commande collectée',
            COMPLETED: 'Commande terminée',
            CANCELLED: 'Commande annulée'
        };

        const statusData = {
            order,
            message: statusMessages[order.status] || 'Statut mis à jour',
            previousStatus: previousStatus
        };
        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_STATUS_UPDATED, statusData);

        if (resteHorsDuRestaurant(order, previousStatus)) {
            this.appGateway.emitToBackoffice(OrderChannels.ORDER_STATUS_UPDATED, {
                order: chargeBrouillon(order),
                message: statusData.message,
                previousStatus,
            });
            return;
        }

        // Le client reçoit la commande entière, il est le destinataire du code
        // de récupération. Le restaurant et le backoffice reçoivent une version
        // sans ce code : la room du restaurant est aussi écoutée par ses
        // livreurs, à qui le code doit rester inconnu.
        const statusDataDiffusion = { ...statusData, order: sanitizeOrderForBroadcast(order) };

        this.appGateway.emitToBackoffice(OrderChannels.ORDER_STATUS_UPDATED, statusDataDiffusion);
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_STATUS_UPDATED, statusDataDiffusion);
    }

    emitOrderUpdated(commande: Order) {
        const order = sansIdentifiantsPush(commande);
        const data = { order, message: 'Commande mise à jour' };
        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_UPDATED, data);

        // Panier encore non payé (adresse changée par le client, par exemple),
        // ou annulé par le client et retouché par le centre d'appels.
        if (estBrouillon(order) || estPanierAnnuleParClient(order)) {
            this.appGateway.emitToBackoffice(OrderChannels.ORDER_UPDATED, {
                order: chargeBrouillon(order),
                message: data.message,
            });
            return;
        }

        const dataDiffusion = { ...data, order: sanitizeOrderForBroadcast(order) };
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_UPDATED, dataDiffusion);
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_UPDATED, dataDiffusion);
    }

    /**
     * Seul l'identifiant part : rien de personnel, brouillon ou non. Le
     * restaurant qui n'a jamais vu le brouillon ne connaît pas cet identifiant.
     */
    emitOrderDeleted(order: Order) {
        const data = { orderId: order.id, message: 'Commande supprimée' };

        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_DELETED, data);
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_DELETED, data);
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_DELETED, data);
    }

    /**
     * Émet un événement de rafraîchissement pour forcer tous les clients connectés
     * à recharger la liste des commandes.
     */
    emitOrderRefresh() {
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_REFRESH, {
            message: 'Rafraîchissement des commandes',
            timestamp: new Date().toISOString(),
        });
    }
}
