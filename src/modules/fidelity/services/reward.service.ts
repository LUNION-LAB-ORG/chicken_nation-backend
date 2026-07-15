import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RewardStatus, RewardType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { VoucherService } from 'src/modules/voucher/voucher.service';

/**
 * Récompenses « à gratter » — couche CÉLÉBRATION au-dessus de la comptabilité.
 *
 * Ne remplace AUCUN registre (LoyaltyPoint / Voucher / PromoCodeUsage restent la
 * source de vérité). Un Reward dit seulement : « il y a quelque chose à gratter »,
 * et son statut SCRATCHED est le gate SERVEUR définitif (jamais re-grattable,
 * même après réinstallation ou changement d'appareil).
 */
@Injectable()
export class RewardService {
    private readonly logger = new Logger(RewardService.name);

    constructor(
        private prisma: PrismaService,
        private readonly voucherService: VoucherService,
    ) { }

    /**
     * Crée la récompense « points gagnés » d'une commande.
     * Idempotent par order_id (webhook rejoué / double backend → un seul Reward).
     */
    async createPointsReward({
        customer_id,
        points,
        order_id,
        reason,
    }: {
        customer_id: string;
        points: number;
        order_id: string;
        reason?: string;
    }) {
        if (points <= 0) return null;

        const existing = await this.prisma.reward.findFirst({
            where: { order_id, type: RewardType.POINTS },
        });
        if (existing) return existing;

        try {
            return await this.prisma.reward.create({
                data: {
                    customer_id,
                    type: RewardType.POINTS,
                    payload: { points },
                    reason,
                    order_id,
                },
            });
        } catch (error) {
            // Filet d'idempotence DB : l'index unique partiel Reward(order_id)
            // WHERE type='POINTS' (migration 20260714120000) bloque un 2e Reward
            // POINTS pour la même commande sous concurrence (retry / double backend)
            // que le find-then-create ne couvre pas seul. P2002 → NO-OP : on renvoie
            // le Reward existant. Toute autre erreur est propagée.
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                const raced = await this.prisma.reward.findFirst({
                    where: { order_id, type: RewardType.POINTS },
                });
                if (raced) return raced;
            }
            throw error;
        }
    }

    /**
     * Crée une récompense GIFT (plat offert) PENDING — cadeau « à gratter » qui,
     * une fois révélé, devient récupérable au panier à 0 fr (RG-03). Réutilisé par
     * le module Combo (lot d'un gagnant tiré au sort) : la distribution passe
     * TOUJOURS par le système Reward, jamais par un canal parallèle.
     *
     * `payload` = snapshot GIFT déjà validé/enrichi à la config (item_type, dish_id,
     * name, price, image?) — même forme que RewardCampaignService.buildPayload(GIFT).
     */
    async createGiftReward({
        customer_id,
        payload,
        reason,
        expires_at,
    }: {
        customer_id: string;
        payload: Record<string, any>;
        reason?: string;
        expires_at?: Date | null;
    }) {
        return this.prisma.reward.create({
            data: {
                customer_id,
                type: RewardType.GIFT,
                payload: payload as Prisma.InputJsonValue,
                reason,
                expires_at: expires_at ?? null,
                status: RewardStatus.PENDING,
            },
        });
    }

    /** Récompenses à gratter du client (non expirées), plus récentes d'abord. */
    async getPendingRewards(customer_id: string) {
        return this.prisma.reward.findMany({
            where: {
                customer_id,
                status: RewardStatus.PENDING,
                OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
            },
            orderBy: { created_at: 'desc' },
            select: {
                id: true,
                type: true,
                payload: true,
                reason: true,
                order_id: true,
                created_at: true,
            },
        });
    }

    /**
     * Cadeaux (GIFT) « à utiliser » du client : grattés (révélés) mais pas encore
     * consommés et non expirés. Le client peut les ajouter à son panier à 0 fr.
     * VOUCHER/PROMO n'apparaissent PAS ici : leur instrument est déjà produit au
     * grattage (bon créé / code révélé) — ils ne se « consomment » pas via le panier.
     */
    async getRedeemableGifts(customer_id: string) {
        return this.prisma.reward.findMany({
            where: {
                customer_id,
                type: RewardType.GIFT,
                status: RewardStatus.SCRATCHED,
                OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
            },
            orderBy: { created_at: 'desc' },
            select: {
                id: true,
                type: true,
                payload: true,
                reason: true,
                expires_at: true,
                created_at: true,
            },
        });
    }

    /**
     * Marque une récompense comme GRATTÉE — claim ATOMIQUE (updateMany conditionné
     * par le statut PENDING) : idempotent, et cloisonné par customer_id (le client
     * ne peut gratter que SES récompenses).
     */
    async scratchReward(customer_id: string, reward_id: string) {
        const claim = await this.prisma.reward.updateMany({
            where: { id: reward_id, customer_id, status: RewardStatus.PENDING },
            data: { status: RewardStatus.SCRATCHED, scratched_at: new Date(), updated_at: new Date() },
        });

        if (claim.count === 0) {
            // Déjà grattée (idempotence) OU inexistante/pas à lui → on distingue.
            const reward = await this.prisma.reward.findFirst({
                where: { id: reward_id, customer_id },
                select: { id: true, status: true, type: true, payload: true, reason: true },
            });
            if (!reward) throw new NotFoundException('Récompense introuvable');
            // Idempotent : on renvoie le contenu déjà révélé (ex. code voucher
            // persisté dans le payload au 1er grattage).
            return {
                scratched: false,
                already: true,
                status: reward.status,
                reward: { id: reward.id, type: reward.type, payload: reward.payload, reason: reward.reason },
            };
        }

        // Grattage réussi → révéler le contenu. Pour un VOUCHER, on crée MAINTENANT
        // le vrai bon d'achat (pas de bon dormant) et on le persiste dans le payload.
        const reward = await this.prisma.reward.findUnique({
            where: { id: reward_id },
            include: { campaign: true },
        });
        let payload = (reward?.payload ?? {}) as Record<string, any>;

        if (reward && reward.type === RewardType.VOUCHER) {
            const amount = Number(payload?.amount ?? 0);
            // created_by : campagne « Envoyer un cadeau » OU injecté dans le payload
            // (récompense de parrainage — sans campagne).
            const createdBy = reward.campaign?.created_by ?? (payload?.created_by as string | undefined);
            if (amount > 0 && createdBy) {
                // Source unique de création (WS + notif in-app identiques à la route admin).
                const voucher = await this.voucherService.createForCustomer({
                    customerId: customer_id,
                    amount,
                    createdBy,
                    expiresAt: reward.expires_at ?? null,
                });
                payload = { ...payload, code: voucher.code, voucher_id: voucher.id };
                await this.prisma.reward.update({ where: { id: reward_id }, data: { payload } });
            }
        }

        return {
            scratched: true,
            already: false,
            status: RewardStatus.SCRATCHED,
            reward: reward
                ? { id: reward.id, type: reward.type, payload, reason: reward.reason }
                : undefined,
        };
    }

    /**
     * Révoque les récompenses PENDING d'une commande (annulation) — atomique,
     * no-op si déjà grattée ou aucune récompense.
     */
    async revokeForOrder(order_id: string, reason?: string) {
        const res = await this.prisma.reward.updateMany({
            where: { order_id, status: RewardStatus.PENDING },
            data: {
                status: RewardStatus.REVOKED,
                ...(reason ? { reason } : {}),
                updated_at: new Date(),
            },
        });
        if (res.count > 0) {
            this.logger.log(`Reward(s) révoqué(s) pour la commande ${order_id}: ${res.count}`);
        }
        return res;
    }

    /**
     * Restaure les cadeaux (GIFT) CONSUMED sur une commande ANNULÉE : ils repassent
     * SCRATCHED (réutilisables) et sont détachés de la commande (order_id/consumed_at
     * remis à null). Sinon le client perdrait injustement son cadeau si la commande
     * est annulée. Atomique, idempotent, no-op si aucun cadeau consommé.
     * NB : on ne touche PAS `reason` (garde le libellé de campagne pour le ré-affichage) ;
     * un cadeau expiré entre-temps ne réapparaîtra pas (filtre d'expiration côté lecture).
     */
    async restoreConsumedGiftsForOrder(order_id: string) {
        const res = await this.prisma.reward.updateMany({
            where: { order_id, type: RewardType.GIFT, status: RewardStatus.CONSUMED },
            data: {
                status: RewardStatus.SCRATCHED,
                order_id: null,
                consumed_at: null,
                updated_at: new Date(),
            },
        });
        if (res.count > 0) {
            this.logger.log(`Cadeau(x) restauré(s) après annulation (commande ${order_id}): ${res.count}`);
        }
        return res;
    }
}
