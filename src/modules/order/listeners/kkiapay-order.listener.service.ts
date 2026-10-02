import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KkiapayChannels } from 'src/kkiapay/kkiapay-channels';
import { KkiapayWebhookDto } from 'src/kkiapay/kkiapay.type';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { OrderEvent } from '../events/order.event';
import { OrderService } from '../services/order.service';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { sansIdentifiantsPush } from '../helpers/identifiants-push.helper';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { RewardService } from 'src/modules/fidelity/services/reward.service';
import { ScratchEngineService } from 'src/modules/fidelity/services/scratch-engine.service';
import { ReferralService } from 'src/modules/referral/referral.service';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import { Order, OrderStatus, LoyaltyPointType, PaymentMethod } from '@prisma/client';
import { libelleRetrait } from 'src/modules/fidelity/helpers/points-commande.rules';

/**
 * Résultat structuré du traitement d'un paiement KKiaPay réussi.
 *   • `confirmed: true`  → la commande est (ou était déjà) confirmée/payée.
 *   • `confirmed: false` → la vérification KKiaPay a échoué (raison lisible dans
 *     `reason`) ; le worker BullMQ ne doit PAS retenter (erreur permanente).
 * Le worker webhook ignore ce retour (il ne se soucie que des exceptions
 * transitoires relancées) ; c'est la confirmation manuelle admin qui l'exploite
 * pour renvoyer un 200 clair ou un 4xx motivé.
 */
export interface ProcessTransactionSuccessResult {
    confirmed: boolean;
    reason?: string;
    justPaid?: boolean;
    order?: Awaited<ReturnType<OrderService['findByReferenceOrNull']>>;
    paiement?: { id: string } | null;
    earnedPoints?: number;
    /** Paiement reçu sur une commande déjà réglée : à rembourser (alerte levée à son enregistrement). */
    enDouble?: boolean;
}

/**
 * Codes d'erreur Prisma considérés TRANSITOIRES (infra DB momentanément
 * indisponible). Relancés pour que BullMQ retente le webhook.
 *   P1001 : impossible d'atteindre le serveur (Neon endormi / blip réseau)
 *   P1002 : serveur atteint mais timeout à l'ouverture
 *   P1008 : timeout d'opération
 *   P1017 : le serveur a fermé la connexion
 *   P2024 : timeout d'obtention d'une connexion du pool
 *   P2037 : trop de connexions ouvertes
 */
const TRANSIENT_DB_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037']);

@Injectable()
export class KkiapayOrderListenerService {
    logger = new Logger(KkiapayOrderListenerService.name);
    constructor(private readonly orderService: OrderService,
        private readonly paiementsService: PaiementsService,
        private orderEvent: OrderEvent,
        private readonly orderWebSocketService: OrderWebSocketService,
        private readonly expoPushService: ExpoPushService,
        private readonly notificationsSender: NotificationsSenderService,
        private readonly loyaltyService: LoyaltyService,
        private readonly rewardService: RewardService,
        private readonly scratchEngineService: ScratchEngineService,
        private readonly referralService: ReferralService,
        private readonly alertes: AlertesService,
    ) { }

    /**
     * Point d'entrée @OnEvent. Émis via emitAsync (cf. KkiapayEvent) : tout rejet
     * remonte jusqu'au worker BullMQ, qui retente. On délègue à processTransactionSuccess
     * qui décide seul quoi relancer (transitoire) et quoi avaler (permanent).
     *
     * ⚠️ `suppressErrors: false` est OBLIGATOIRE ici, sinon la garantie de retry est
     * un NO-OP. Par défaut, @nestjs/event-emitter met `suppressErrors: true` : un rejet
     * du handler est alors AVALÉ par emitAsync, la promesse remonte donc RÉSOLUE au
     * worker, BullMQ croit le job réussi → le webhook est perdu malgré tout. Avec
     * `suppressErrors: false`, le rejet se propage emitAsync → handleEvent → consumer.process
     * → retry BullMQ. C'est le seul abonné de TRANSACTION_SUCCESS (vérifié : aucun autre
     * @OnEvent sur ce canal), donc aucun risque de retry parasite déclenché par un
     * handler non-critique. (Un appel direct consumer → processTransactionSuccess serait
     * plus robuste, mais introduirait un cycle de modules KkiapayModule → OrderModule →
     * PaiementsModule → KkiapayModule ; on garde donc le bus d'événements durci.)
     */
    @OnEvent(KkiapayChannels.TRANSACTION_SUCCESS, { suppressErrors: false })
    async orderStatutReady(payload: KkiapayWebhookDto) {
        // Le résultat est RENDU au bus (emitAsync le collecte) : le worker s'en
        // sert pour journaliser l'issue RÉELLE. Un abandon délibéré
        // (`confirmed: false`) ne lève pas et resterait sinon invisible.
        return await this.processTransactionSuccess(payload);
    }

    /**
     * Traitement AWAITÉ d'un paiement KKiaPay réussi (appelé par le worker via
     * l'event). Sûr au REJEU : peut tourner plusieurs fois pour la même transaction
     * (retry BullMQ, double backend) et ne crédite les points qu'une fois.
     *
     * Contrat transitoire/permanent :
     *   • Commande inconnue (référence absente) → log + return (ACK, pas de retry).
     *   • Erreur DB transitoire (Prisma P1001/P1002/…) → RELANCE → retry BullMQ.
     *   • Toute autre erreur (ex : KKiaPay verify « transaction non trouvée », erreur
     *     applicative) → log + return (ACK). On préfère NE PAS boucler à l'infini ;
     *     le cron de réconciliation (verify-based) est le filet pour ces cas.
     *
     * Retourne un {@link ProcessTransactionSuccessResult} : ignoré par le worker
     * webhook (qui ne réagit qu'aux exceptions transitoires relancées), mais exploité
     * par la confirmation manuelle admin pour distinguer succès / motif d'échec.
     */
    async processTransactionSuccess(
        payload: KkiapayWebhookDto,
    ): Promise<ProcessTransactionSuccessResult> {
        // Erreur permanente : la référence n'existe pas. findByReferenceOrNull ne lève
        // PAS (contrairement à findByReference) → on distingue « commande absente »
        // (permanent) d'une vraie erreur DB transitoire (qui, elle, sera relancée plus bas).
        // Un panier que le client a annulé avant que son paiement ne soit
        // validé est supprimé des listes : on le retrouve quand même, pour y
        // rattacher l'argent reçu (sinon, paiement perdu et commande relançable,
        // donc encaissée une seconde fois à la reprise au téléphone).
        const order = await this.orderService.findByReferenceOrNull(payload.stateData, {
            inclurePanierAnnuleParClient: true,
        });
        if (!order) {
            this.logger.warn(
                `Webhook KKiaPay : aucune commande pour la référence « ${payload.stateData} » ` +
                `(tx ${payload.transactionId}). Ack sans retry.`,
            );
            return { confirmed: false, reason: 'commande introuvable' };
        }

        // Enregistre le paiement + claim atomique de la transition PENDING→ACCEPTED.
        //   justPaid : ce traitement a « gagné » la transition (1re fois) → effets one-time.
        //   isPaid   : le paiement est SUCCESS ET couvre le total → effets idempotents,
        //              rejoués même sur retry (justPaid=false) pour garantir leur exécution.
        let justPaid: boolean;
        let isPaid: boolean;
        let payeApresCoup = false;
        let annuleeRetablie = false;
        let enDouble = false;
        let notPaidReason: string | undefined;
        let paiement: { id: string } | null | undefined;
        try {
            const linked = await this.paiementsService.linkPaiementToOrder({
                transactionId: payload.transactionId,
                orderId: order.id,
                customer_id: order.customer_id,
                // Compte annoncé par la route webhook (a validé SON secret).
                collectorRestaurantId: payload.restaurantId ?? null,
            });
            paiement = linked.paiement;
            justPaid = linked.justPaid;
            isPaid = linked.isPaid;
            payeApresCoup = linked.payeApresCoup;
            annuleeRetablie = linked.annuleeRetablie;
            enDouble = linked.enDouble;
            notPaidReason = linked.notPaidReason;
        } catch (error) {
            // KKiaPay INJOIGNABLE (réseau/5xx, levé par KkiapayService.rawVerify) :
            // transitoire au même titre qu'un blip Neon → relance → retry BullMQ.
            // L'ancien SDK écrasait ce cas en « Transaction non trouvée » → ACK
            // définitif → paiement PERDU (revue 31/07).
            if (error instanceof ServiceUnavailableException) {
                this.logger.warn(
                    `KKiaPay injoignable pour la commande ${order.reference} — relance pour retry BullMQ.`,
                );
                throw error;
            }
            if (this.isTransientDbError(error)) {
                this.logger.warn(
                    `Erreur DB transitoire (${(error as any)?.code ?? (error as any)?.errorCode}) ` +
                    `sur la commande ${order.reference} — relance pour retry BullMQ.`,
                );
                throw error; // → BullMQ retente jusqu'au rétablissement de Neon
            }
            this.logger.error(
                `Erreur non-transitoire au traitement du paiement de la commande ${order.reference} ` +
                `(ack sans retry, réconciliation prendra le relais) : ${(error as any)?.message}`,
                (error as any)?.stack,
            );
            // verifyTransaction lève BadRequestException(« Transaction non trouvée »)
            // → tx inconnue de KKiaPay (motif lisible pour l'admin). Toute autre erreur
            // applicative reste permanente (ack, réconciliation prendra le relais).
            const reason =
                error instanceof BadRequestException
                    ? 'transaction introuvable'
                    : 'erreur de traitement du paiement';
            return { confirmed: false, reason };
        }

        // Paiement non abouti (FAILED / non couvert) → rien à faire. `notPaidReason`
        // précise le motif (statut non SUCCESS vs montant non couvert) pour l'admin.
        if (!isPaid) {
            return { confirmed: false, reason: notPaidReason ?? 'paiement non abouti' };
        }

        /**
         * PAIEMENT TARDIF : la commande était déjà sortie de PENDING (reprise
         * par le personnel, confirmée au téléphone) et ce paiement vient de la
         * solder. Aucun autre événement ne part sur ce chemin : sans ce
         * socket, la caisse et le tiroir d'opérations gardent la commande « à
         * encaisser » et proposent d'encaisser une seconde fois.
         */
        if (payeApresCoup) {
            try {
                const commandePayee = await this.orderService.findById(order.id);
                this.orderWebSocketService.emitOrderUpdated(commandePayee as Order);
            } catch (error) {
                this.logger.warn(
                    `Commande ${order.reference} payée après coup, écrans non prévenus : ${(error as any)?.message}`,
                );
            }
        }

        /**
         * PAIEMENT REÇU DEUX FOIS : la commande était déjà réglée. L'alerte
         * « à rembourser » est partie à l'enregistrement du paiement
         * (`PaiementsService`), une seule fois et quelle que soit la façon de
         * payer de la commande. On ne la double pas de l'alerte de reprise
         * ci-dessous, qui dirait moins bien la même chose ; un rejeu reste
         * silencieux.
         */
        if (enDouble) {
            this.logger.warn(
                `Paiement ${payload.transactionId} reçu sur la commande ${order.reference} déjà réglée : ` +
                `à rembourser.`,
            );
        } else if (!justPaid && order.payment_method === PaymentMethod.OFFLINE) {
            /**
             * Argent reçu en ligne sur une commande payable à la caisse : la
             * caisse, le livreur ou Turbo (dont la course garde le montant à
             * encaisser de son envoi) ont pu, ou vont, encaisser le client une
             * seconde fois. Rien ne le rattrape automatiquement : on prévient.
             */
            this.alertes.signaler({
                code: CodeAlerte.PAIEMENT_APRES_REPRISE,
                restaurantId: order.restaurant_id,
                reference: order.reference,
                details: [
                    `Le client a payé dans l'application alors que la commande est à encaisser en caisse ou à la livraison.`,
                    order.paied
                        ? `La commande était déjà marquée payée : comparer ses paiements, un double encaissement est probable.`
                        : `Vérifier qu'elle n'a pas aussi été encaissée au comptoir ou par le livreur, et prévenir le livreur s'il ne l'a pas encore livrée.`,
                ],
                cleBridage: `${CodeAlerte.PAIEMENT_APRES_REPRISE}:${order.reference}`,
                meta: { orderId: order.id, transactionId: payload.transactionId, statut: order.status },
            });
        }

        /**
         * Assiette des remises rejouée au paiement, alignée sur celle du calcul :
         * prix du plat ET options du menu composable, suppléments à la carte
         * exclus.
         *
         * ⚠️ L'ancienne formule `amount * quantity` comptait la quantité DEUX
         * FOIS sur ce chemin : `amount` y vaut déjà prix unitaire fois quantité
         * (commandes passées depuis l'application, les seules payées en ligne).
         * Deux plats identiques gonflaient donc l'assiette au carré, et l'usage
         * de promotion enregistré ne correspondait pas à la remise accordée.
         * Les colonnes de prix figé permettent enfin de la calculer juste.
         */
        const assietteLigne = (item: {
            amount: number;
            quantity: number;
            unit_price: number | null;
            options: unknown;
        }) => {
            const optionsUnitaire = Array.isArray(item.options)
                ? (item.options as { price_delta?: number }[]).reduce(
                    (somme, choix) => somme + (Number(choix.price_delta) || 0),
                    0,
                )
                : 0;
            // Repli pour les rares lignes antérieures au prix figé : sur ce
            // chemin, `amount` porte le total de la ligne, donc on redivise.
            const unitaire = item.unit_price
                ?? (item.quantity > 0 ? item.amount / item.quantity : item.amount);
            return (unitaire + optionsUnitaire) * item.quantity;
        };

        const totalDishes = order.order_items.reduce(
            (sum, item) => sum + assietteLigne(item),
            0,
        );

        // Effets STRICTEMENT ONE-TIME NE DÉPENDANT PAS DES POINTS — émis sur la 1re
        // confirmation (justPaid), AVANT les effets comptables relançables. Ainsi, si un
        // blip Neon transitoire survient PENDANT le gain de points (après le claim
        // PENDING→ACCEPTED déjà consommé), le retry BullMQ arrive avec justPaid=false et
        // NE prive PAS la cuisine de sa cloche ni de l'event de création (déjà émis ici).
        if (justPaid) {
            // 🔔 CLOCHE staff resto. linkPaiementToOrder a passé le statut à ACCEPTED ;
            // on le force ici car l'objet `order` (pré-update) est encore PENDING.
            void this.notificationsSender.sendOrderBell({ ...order, status: OrderStatus.ACCEPTED });

            // Événement de création (notif staff + WebSocket) — une seule fois, au paiement.
            this.orderEvent.orderCreatedEvent({
                order: order,
                payment_id: paiement?.id,
                loyalty_level: order.customer.loyalty_level!,
                totalDishes: totalDishes,
                orderItems: order.order_items.map(item => ({
                    dish_id: item.dish_id,
                    quantity: item.quantity,
                    // Prix UNITAIRE, options comprises : même assiette que ci-dessus.
                    price: item.quantity > 0 ? assietteLigne(item) / item.quantity : assietteLigne(item),
                })),
            });

            this.orderWebSocketService.emitOrderCreated(order);
        }

        // ⭐ EFFETS IDEMPOTENTS — rejoués à CHAQUE traitement d'un paiement abouti
        // (1re fois ET retries), car chacun est idempotent par order_id. Garantit que
        // les points finissent par être crédités même si le 1er passage a partiellement
        // échoué, SANS jamais double-créditer.
        //
        // GAIN DE POINTS FIDÉLITÉ — SEUL point de gain des commandes app EN LIGNE.
        // addPoints émet l'event WS `loyalty:points_added` → carte à gratter côté app.
        // Idempotent par order_id, non bloquant (on trace l'échec sans casser la confirmation).
        /**
         * Commande ANNULÉE (annulée par le client avant la validation de son
         * paiement, ou par le personnel) : l'argent est rattaché et une alerte
         * part pour le rembourser (`PaiementsService`), mais elle ne rapporte
         * rien. Ni points, ni carte à gratter, ni gain de parrainage : ces
         * effets ont été révoqués, ou n'ont jamais eu lieu, à l'annulation.
         */
        if (order.status === OrderStatus.CANCELLED || annuleeRetablie) {
            this.logger.warn(
                `Paiement ${payload.transactionId} reçu sur la commande annulée ${order.reference} : ` +
                `rattaché, sans effet de fidélité (remboursement à traiter).`,
            );
            return { confirmed: true, justPaid, order: sansIdentifiantsPush(order), paiement, earnedPoints: 0, enDouble };
        }

        // ⭐ RETRAIT DES POINTS UTILISÉS, DÈS LE PAIEMENT (02/10).
        // Le paiement fait passer la commande de PENDING à ACCEPTED sans
        // événement de statut, et la création réémise plus haut porte la
        // commande d'AVANT, encore PENDING : aucun retrait de
        // OrderListenerService ne partait, les points n'étaient retirés qu'à la
        // clôture. Entre-temps, ils pouvaient payer un second panier.
        // Effet idempotent (une seule ligne de retrait par commande), rejoué à
        // chaque passage comme le gain ci-dessous : sans effet si la reprise au
        // téléphone ou l'acceptation a déjà retiré ces points.
        if (order.points > 0) {
            try {
                await this.loyaltyService.redeemPoints({
                    customer_id: order.customer_id,
                    points: order.points,
                    order_id: order.id,
                    reason: libelleRetrait(order.points, order.reference),
                });
            } catch (error) {
                if (this.isTransientDbError(error)) {
                    this.logger.warn(
                        `Erreur DB transitoire au retrait des points (commande ${order.reference}), ` +
                        `relance pour que BullMQ retente.`,
                    );
                    throw error;
                }
                // Solde devenu insuffisant (deux paniers non payés portaient les
                // mêmes points, et l'autre a été payé avant) : la remise est
                // acquise, rien à reprendre automatiquement. Le filet de la
                // clôture retentera, sans effet de plus si le solde reste court.
                this.logger.error(
                    `Échec du retrait de ${order.points} points au paiement de la commande ${order.reference} : ` +
                    `${(error as any)?.message}`,
                    (error as any)?.stack,
                );
                // Solde trop court : la remise a été accordée sur des points
                // déjà dépensés ailleurs. Rien ne se rattrape tout seul, on
                // prévient pour que l'équipe décide (ajuster le solde, appeler
                // le client). Les autres échecs restent dans le journal.
                if (/insuffisant/i.test(String((error as any)?.message ?? ''))) {
                    this.alertes.signaler({
                        code: CodeAlerte.POINTS_NON_RETIRES,
                        restaurantId: order.restaurant_id,
                        reference: order.reference,
                        details: [
                            `La commande a été payée avec une remise de ${order.points} points, mais le solde du client ne les couvre plus : ils ont déjà servi sur une autre commande.`,
                            `Vérifier l'historique de points du client et ajuster son solde si besoin.`,
                        ],
                        cleBridage: `${CodeAlerte.POINTS_NON_RETIRES}:${order.reference}`,
                        meta: { orderId: order.id, customerId: order.customer_id, points: order.points },
                    });
                }
            }
        }

        let earnedPoints = 0;
        try {
            if (order.net_amount > 0) {
                earnedPoints = await this.loyaltyService.calculatePointsForOrder(order.net_amount);
                if (earnedPoints > 0) {
                    await this.loyaltyService.addPoints({
                        customer_id: order.customer_id,
                        points: earnedPoints,
                        type: LoyaltyPointType.EARNED,
                        reason: `🎁 ${earnedPoints} points gagnés pour la commande #${order.reference}`,
                        order_id: order.id,
                    });
                }
            }

            // 🎫 GRATTE & GAGNE — HORS du garde `earnedPoints > 0` : TOUTE commande payée
            // doit pouvoir tirer un GROS LOT bonus, même à 0 point de base (le lot PLANCHER
            // createPointsReward(0) est alors un simple no-op). Le grattage est le CANAL DE
            // PRÉSENTATION des points de base (lot PLANCHER, coût enveloppe 0) et RAREMENT
            // d'un gros lot « en plus » (coût compté dans l'enveloppe). Le moteur crée le(s)
            // Reward « à gratter » (idempotent par order_id : un seul ScratchDraw par
            // commande) ; les points de base (addPoints) NE sont JAMAIS modifiés. Reste dans
            // le bloc EFFETS IDEMPOTENTS : rejoué au retry, erreurs transitoires relancées.
            await this.scratchEngineService.drawForOrder({
                order: {
                    id: order.id,
                    customer_id: order.customer_id,
                    net_amount: order.net_amount,
                    reference: order.reference,
                    customer: { loyalty_level: order.customer?.loyalty_level ?? null },
                },
                earnedPoints,
            });
        } catch (error) {
            // GARANTIE COMPTABLE : une erreur DB TRANSITOIRE (Neon P1001…) survenue
            // APRÈS le claim PENDING→ACCEPTED (justPaid déjà consommé) perdrait
            // définitivement les points si on l'avalait. On la RELANCE → BullMQ retente,
            // et les effets idempotents-par-order_id (addPoints / createPointsReward)
            // finissent par s'exécuter sans jamais double-créditer. Les erreurs
            // NON-transitoires restent avalées (best-effort : on ne boucle pas à l'infini).
            if (this.isTransientDbError(error)) {
                this.logger.warn(
                    `Erreur DB transitoire au gain de points (commande ${order.reference}) — ` +
                    `relance pour retry BullMQ afin de garantir le crédit.`,
                );
                throw error;
            }
            this.logger.error(
                `Échec gain points (paiement) pour la commande ${order.reference}: ${error?.message}`,
                error?.stack,
            );
            earnedPoints = 0;
        }

        // 🤝 PARRAINAGE — accrual monétaire (Phase 5) au paiement d'une commande du filleul.
        // ENGLOBE la qualification (carte à gratter parrain + PRIME à la 1re commande) ET la
        // COMMISSION (% du CA dans la fenêtre). Idempotent (claim atomique PENDING→REWARDED +
        // unique (source_order_id,type)), no-op sans parrainage. Effet COMPTABLE → awaité et
        // relancé sur erreur transitoire (le retry BullMQ finit par accréditer sans doublon).
        // Erreur non-transitoire avalée (best-effort).
        try {
            await this.referralService.accrueForPaidOrder(order.customer_id, order.id);
        } catch (error) {
            // KKiaPay INJOIGNABLE (réseau/5xx, levé par KkiapayService.rawVerify) :
            // transitoire au même titre qu'un blip Neon → relance → retry BullMQ.
            // L'ancien SDK écrasait ce cas en « Transaction non trouvée » → ACK
            // définitif → paiement PERDU (revue 31/07).
            if (error instanceof ServiceUnavailableException) {
                this.logger.warn(
                    `KKiaPay injoignable pour la commande ${order.reference} — relance pour retry BullMQ.`,
                );
                throw error;
            }
            if (this.isTransientDbError(error)) {
                this.logger.warn(
                    `Erreur DB transitoire à l'accrual parrainage (commande ${order.reference}) — ` +
                    `relance pour retry BullMQ.`,
                );
                throw error;
            }
            this.logger.error(
                `Échec accrual parrainage (commande ${order.reference}): ${(error as any)?.message}`,
                (error as any)?.stack,
            );
        }

        // 📲 Push « Commande confirmée » au CLIENT — one-time (justPaid), APRÈS le gain
        // de points car il mentionne `earnedPoints`. BEST-EFFORT : si un passage antérieur
        // a relancé (points en erreur transitoire) avant d'arriver ici, le retry BullMQ
        // aura justPaid=false → le push ne partira pas. On l'accepte : les effets
        // COMPTABLES (points/reward/parrainage) sont garantis par le retry, et la cloche
        // + l'event de création ont déjà été émis plus haut (avant le bloc comptable).
        if (justPaid) {
            const expoToken = order.customer?.notification_settings?.expo_push_token;
            if (expoToken) {
                this.expoPushService.sendPushNotifications({
                    tokens: [expoToken],
                    title: "🍗 Commande confirmée !",
                    body: `Merci pour votre confiance ❤️\nVotre paiement est validé. Votre commande ${order.reference} a bien été reçue.${earnedPoints > 0 ? `\n⭐ Vous avez gagné ${earnedPoints} points fidélité !` : ''}`,
                    data: { order_id: order.id },
                    subtitle: "On prépare ça avec amour 🔥",
                    sound: "default",
                    badge: 1,
                    priority: 'high',
                    ttl: 3600,
                    channelId: "default",
                    categoryId: "order-created",
                });
            }
        }

        // Le jeton Expo lu plus haut ne quitte pas ce service : ce résultat
        // devient la réponse HTTP de la confirmation manuelle.
        return { confirmed: true, justPaid, order: sansIdentifiantsPush(order), paiement, earnedPoints, enDouble };
    }

    /**
     * CONFIRMATION MANUELLE ADMIN d'un paiement en ligne (POST /orders/:id/confirm-payment).
     *
     * Passe par le MÊME chemin que le webhook (processTransactionSuccess → linkPaiementToOrder),
     * qui RE-VÉRIFIE la transaction auprès de KKiaPay (verifyTransaction) et ne confirme
     * QUE si SUCCESS + montant couvert. Aucun « force » : impossible de marquer payé sans
     * un verify KKiaPay positif. 100 % idempotent (rejouable sans double-crédit).
     *
     * Garde-fous en amont (avant tout effet) :
     *   • Commande absente → 404 (via orderService.findById).
     *   • Commande non ONLINE → 400 (ce flux ne concerne que le paiement en ligne).
     *   • Commande déjà avancée (≠ PENDING) → 409 (déjà payée / en préparation…).
     *
     * @returns { confirmed:true, order, paiement } si KKiaPay valide le paiement.
     * @throws BadRequestException avec un motif clair si le verify KKiaPay échoue
     *   (« transaction introuvable » / « KKiaPay: statut non SUCCESS » / « montant non couvert »).
     */
    async confirmPaymentManually(orderId: string, transactionId: string) {
        // 404 si absente (findById lève NotFoundException).
        const order = await this.orderService.findById(orderId);

        if (order.payment_method !== PaymentMethod.ONLINE) {
            throw new BadRequestException(
                'Confirmation manuelle réservée aux commandes payées EN LIGNE (KKiaPay).',
            );
        }
        if (order.status !== OrderStatus.PENDING) {
            throw new BadRequestException(
                `Commande déjà traitée (statut ${order.status}) : la confirmation manuelle ne ` +
                `s'applique qu'aux commandes en attente de paiement (PENDING).`,
            );
        }

        // Payload synthétique identique à celui d'un webhook « transaction.success ».
        // Seuls transactionId + stateData (référence) sont réellement utilisés en aval :
        // linkPaiementToOrder re-vérifie la transaction auprès de KKiaPay et se sert des
        // valeurs RÉELLES (montant, statut…) — pas de celles du payload. Cast volontaire
        // pour ne pas fabriquer les champs KKiaPay inutilisés (method/fees/performedAt…).
        const payload = {
            event: 'transaction.success',
            transactionId,
            stateData: order.reference,
            amount: order.amount,
            isPaymentSucces: true,
        } as unknown as KkiapayWebhookDto;

        const result = await this.processTransactionSuccess(payload);

        if (!result.confirmed) {
            // Motif de refus KKiaPay (déjà formulé lisiblement en amont) → 400 pour que
            // l'admin sache POURQUOI : « KKiaPay: statut non SUCCESS » / « montant non
            // couvert » / « transaction introuvable ».
            throw new BadRequestException(result.reason ?? 'Confirmation KKiaPay impossible');
        }

        return { confirmed: true, order: result.order, paiement: result.paiement };
    }

    /** Vrai si l'erreur est un code Prisma transitoire (infra DB) → à relancer. */
    private isTransientDbError(error: any): boolean {
        const code = error?.code ?? error?.errorCode;
        return typeof code === 'string' && TRANSIENT_DB_CODES.has(code);
    }
}
