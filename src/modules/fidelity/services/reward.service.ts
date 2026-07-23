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
     * PORTEFEUILLE D'AVANTAGES — endpoint UNIQUE de l'écran « Mes cadeaux ».
     *
     * Fusionne ici, côté serveur, ce que l'app devait auparavant recoller depuis
     * trois appels (rewards + bons + utilisations) :
     *  - Reward : cartes à gratter (bon, code promo, plat/supplément offert, points)
     *  - Voucher : bons réellement émis, avec leur solde restant
     *  - Redemption : dernière utilisation d'un bon → date « Utilisé le … »
     *
     * ⚠️ Dédoublonnage : gratter un Reward VOUCHER **crée** un Voucher ; les deux
     * décrivent le même avantage. Le Voucher fait autorité (solde, expiration) et
     * le Reward source est écarté.
     *
     * Renvoie une liste PLATE triée du plus récent au plus ancien, paginée : un
     * seul statut par ligne, aucune section à recomposer côté client.
     */
    async getWallet(customer_id: string, page = 1, limit = 20) {
        const safePage = Math.max(1, Math.floor(page));
        const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));

        // Volumes bornés (un client a des dizaines d'avantages, pas des milliers) :
        // on charge, on fusionne en mémoire, puis on découpe la page demandée.
        const [rewards, vouchers, redemptions] = await Promise.all([
            this.prisma.reward.findMany({
                where: { customer_id },
                orderBy: { created_at: 'desc' },
                take: 300,
                select: {
                    id: true, type: true, status: true, payload: true, reason: true,
                    order_id: true, scratched_at: true, consumed_at: true,
                    expires_at: true, created_at: true,
                },
            }),
            this.prisma.voucher.findMany({
                where: { customer_id, entity_status: 'ACTIVE' },
                orderBy: { created_at: 'desc' },
                take: 300,
                select: {
                    id: true, code: true, initial_amount: true, remaining_amount: true,
                    status: true, expires_at: true, created_at: true,
                },
            }),
            this.prisma.redemption.findMany({
                where: { voucher: { customer_id } },
                orderBy: { created_at: 'desc' },
                take: 300,
                select: { voucher_id: true, created_at: true },
            }),
        ]);

        const lastUseByVoucher = new Map<string, Date>();
        for (const r of redemptions) {
            if (!lastUseByVoucher.has(r.voucher_id)) lastUseByVoucher.set(r.voucher_id, r.created_at);
        }

        const voucherCodes = new Set(vouchers.map((v) => v.code));
        const items = [
            ...rewards
                .filter((r) => {
                    const code = (r.payload as any)?.code;
                    return !(r.type === RewardType.VOUCHER && code && voucherCodes.has(code));
                })
                .map((r) => this.rewardToWalletItem(r)),
            ...vouchers.map((v) => this.voucherToWalletItem(v, lastUseByVoucher.get(v.id))),
        ].sort((a, b) => new Date(b.obtained_at).getTime() - new Date(a.obtained_at).getTime());

        const total = items.length;
        const start = (safePage - 1) * safeLimit;

        return {
            data: items.slice(start, start + safeLimit),
            meta: {
                page: safePage,
                limit: safeLimit,
                total,
                total_pages: Math.max(1, Math.ceil(total / safeLimit)),
                has_more: start + safeLimit < total,
            },
        };
    }

    /** Formate une date en « 23 juil. 2026 » (libellés prêts à afficher). */
    private static fmtDate(d?: Date | null): string {
        return d
            ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
            : '';
    }

    /** Un Reward NON gratté ne dévoile rien : ni nom, ni valeur (c'est la surprise). */
    private rewardToWalletItem(r: {
        id: string; type: RewardType; status: RewardStatus; payload: Prisma.JsonValue;
        reason: string | null; consumed_at: Date | null; scratched_at: Date | null;
        expires_at: Date | null; created_at: Date;
    }) {
        const p = (r.payload ?? {}) as Record<string, any>;
        const pending = r.status === RewardStatus.PENDING;
        const expired = !!r.expires_at && r.expires_at.getTime() < Date.now() && r.status !== RewardStatus.CONSUMED;

        const kind = pending
            ? 'MYSTERY'
            : r.type === RewardType.VOUCHER
                ? 'VOUCHER'
                : r.type === RewardType.PROMO_CODE
                    ? 'PROMO_CODE'
                    : r.type === RewardType.POINTS
                        ? 'POINTS'
                        : p.item_type === 'SUPPLEMENT'
                            ? 'SUPPLEMENT'
                            : 'DISH';

        let title: string;
        if (pending) title = 'Cadeau surprise';
        else if (r.type === RewardType.VOUCHER) {
            const a = Number(p.amount) || 0;
            title = a ? `Bon d'achat de ${a.toLocaleString('fr-FR')} F` : "Bon d'achat";
        } else if (r.type === RewardType.PROMO_CODE) title = p.code ? `Code promo ${p.code}` : 'Code promo';
        else if (r.type === RewardType.POINTS) {
            const pts = Number(p.points) || 0;
            title = pts ? `${pts} points de fidélité` : 'Points de fidélité';
        } else title = p.label || p.name || 'Cadeau';

        let status: string;
        let status_label: string;
        if (expired) {
            status = 'EXPIRED';
            status_label = `Expiré le ${RewardService.fmtDate(r.expires_at)}`;
        } else if (pending) {
            status = 'TO_SCRATCH';
            status_label = 'À gratter';
        } else if (r.status === RewardStatus.CONSUMED) {
            status = 'USED';
            status_label = `Utilisé le ${RewardService.fmtDate(r.consumed_at ?? r.created_at)}`;
        } else if (r.status === RewardStatus.REVOKED) {
            status = 'EXPIRED';
            status_label = 'Annulé';
        } else if (r.type === RewardType.POINTS) {
            status = 'USED';
            status_label = `Crédités le ${RewardService.fmtDate(r.scratched_at ?? r.created_at)}`;
        } else {
            status = 'AVAILABLE';
            status_label = r.expires_at
                ? `Valable jusqu'au ${RewardService.fmtDate(r.expires_at)}`
                : 'Disponible';
        }

        return {
            id: `reward:${r.id}`,
            kind,
            title,
            status,
            status_label,
            amount: pending ? null : Number(p.amount ?? p.price) || null,
            initial_amount: null as number | null,
            remaining: null as number | null,
            code: pending ? null : (p.code ?? null),
            image: pending ? null : (p.image ?? null),
            obtained_at: r.created_at,
            expires_at: r.expires_at,
            reason: r.reason,
            // De quoi agir depuis l'app (gratter / ajouter au panier).
            reward_id: r.id,
            reward_type: r.type,
            reward_payload: r.payload,
        };
    }

    private voucherToWalletItem(
        v: {
            id: string; code: string; initial_amount: number; remaining_amount: number;
            status: string; expires_at: Date | null; created_at: Date;
        },
        usedAt?: Date,
    ) {
        const expiredByDate = !!v.expires_at && v.expires_at.getTime() < Date.now();
        const exhausted = v.remaining_amount <= 0;
        const partiallyUsed = v.remaining_amount > 0 && v.remaining_amount < v.initial_amount;

        let status: string;
        let status_label: string;
        if (v.status === 'CANCELLED') {
            status = 'EXPIRED';
            status_label = 'Annulé';
        } else if (exhausted) {
            status = 'USED';
            status_label = usedAt ? `Utilisé le ${RewardService.fmtDate(usedAt)}` : 'Entièrement utilisé';
        } else if (v.status === 'EXPIRED' || expiredByDate) {
            status = 'EXPIRED';
            status_label = `Expiré le ${RewardService.fmtDate(v.expires_at)}`;
        } else if (partiallyUsed) {
            status = 'AVAILABLE';
            status_label = `${v.remaining_amount.toLocaleString('fr-FR')} F restants`;
        } else {
            status = 'AVAILABLE';
            status_label = v.expires_at
                ? `Valable jusqu'au ${RewardService.fmtDate(v.expires_at)}`
                : 'Disponible';
        }

        return {
            id: `voucher:${v.id}`,
            kind: 'VOUCHER',
            title: `Bon d'achat de ${v.initial_amount.toLocaleString('fr-FR')} F`,
            status,
            status_label,
            amount: v.initial_amount,
            initial_amount: v.initial_amount,
            remaining: v.remaining_amount,
            code: v.code,
            image: null as string | null,
            obtained_at: v.created_at,
            expires_at: v.expires_at,
            reason: null as string | null,
            reward_id: null as string | null,
            reward_type: null as RewardType | null,
            reward_payload: null as Prisma.JsonValue | null,
        };
    }

    /**
     * TOUS les cadeaux du client — l'espace « Mes cadeaux » de l'app : à gratter
     * (PENDING), disponibles (SCRATCHED non consommés), et l'historique
     * (CONSUMED / expirés). Borné aux 100 plus récents.
     */
    async getMyRewards(customer_id: string) {
        return this.prisma.reward.findMany({
            where: { customer_id },
            orderBy: { created_at: 'desc' },
            take: 100,
            select: {
                id: true,
                type: true,
                status: true,
                payload: true,
                reason: true,
                order_id: true,
                scratched_at: true,
                consumed_at: true,
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
