import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RewardStatus, RewardType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';

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

    constructor(private prisma: PrismaService) { }

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

        return this.prisma.reward.create({
            data: {
                customer_id,
                type: RewardType.POINTS,
                payload: { points },
                reason,
                order_id,
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
            const createdBy = reward.campaign?.created_by;
            if (amount > 0 && createdBy) {
                const voucher = await this.createVoucherForReward(
                    customer_id,
                    amount,
                    createdBy,
                    reward.expires_at ?? null,
                );
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

    /** Génère un code voucher unique (format CNV-YYMMDD-XXXXXX). */
    private generateVoucherCode(): string {
        const d = new Date();
        const y = d.getFullYear().toString().slice(-2);
        const m = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
        return `CNV-${y}${m}${day}-${rnd}`;
    }

    /** Crée le Voucher d'un reward VOUCHER au grattage (retry sur collision de code). */
    private async createVoucherForReward(
        customer_id: string,
        amount: number,
        created_by: string,
        expires_at: Date | null,
    ) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await this.prisma.voucher.create({
                    data: {
                        initial_amount: amount,
                        remaining_amount: amount,
                        customer_id,
                        code: this.generateVoucherCode(),
                        created_by,
                        expires_at,
                    },
                });
            } catch (e: any) {
                if (e?.code === 'P2002' && attempt < 2) continue; // code déjà pris → retry
                throw e;
            }
        }
        throw new Error('Génération du code voucher impossible');
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
}
