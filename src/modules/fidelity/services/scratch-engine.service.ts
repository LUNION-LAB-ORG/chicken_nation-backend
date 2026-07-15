import { Injectable, Logger } from '@nestjs/common';
import { Prisma, RewardStatus, RewardType, LoyaltyLevel, ScratchLot, ScratchDraw } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { RewardService } from './reward.service';

/** Rang des niveaux de fidélité (pour comparer level_min <= niveau client). */
const LEVEL_RANK: Record<LoyaltyLevel, number> = {
    [LoyaltyLevel.STANDARD]: 1,
    [LoyaltyLevel.VIP]: 2,
    [LoyaltyLevel.VVIP]: 3,
};

/** Commande minimale attendue par le moteur (sous-ensemble de findByReferenceOrNull). */
export interface ScratchOrderInput {
    id: string;
    customer_id: string;
    /**
     * CA panier NET (order.net_amount), PAS le TTC (order.amount). L'enveloppe (cible)
     * et l'éligibilité min_cart (RG-09) se calculent sur le net pour rester cohérents
     * avec le calcul des points de base (calculatePointsForOrder(net_amount)).
     */
    net_amount: number;
    reference: string;
    customer?: { loyalty_level?: LoyaltyLevel | null } | null;
}

interface ScratchConfig {
    enabled: boolean;
    envelopePct: number; // % du panier = surcoût moyen ciblé
    windowDays: number; // fenêtre glissante de la compta d'enveloppe
    floorWeight: number; // poids implicite (élevé) du plancher
}

/** Une entrée pondérée du tirage (un gros lot avec son poids effectif). */
interface WeightedEntry {
    lot: ScratchLot;
    weight: number;
    cost: number;
}

/** Distribution effective : plancher + gros lots, avec probabilités et surcoût attendu. */
export interface ScratchDistribution {
    amount: number;
    target_cost: number;
    realized_avg_cost: number;
    expected_cost: number;
    floor: { probability: number };
    lots: Array<{
        id: string;
        label: string;
        reward_type: RewardType;
        weight: number;
        effective_weight: number;
        unit_cost: number;
        probability: number;
        eligible: boolean;
        reason?: string;
    }>;
}

/**
 * MOTEUR « Gratte & Gagne » (cahier 4.2).
 *
 * Le grattage est un CANAL DE PRÉSENTATION du `Reward` existant, PAS la récompense
 * elle-même. Les points de fidélité de base (addPoints → statut/niveau) sont
 * TOUJOURS crédités par le listener AVANT ce moteur et NE sont JAMAIS touchés ici.
 *
 * À chaque commande app payée, `drawForOrder` produit UN tirage :
 *   • LOT PLANCHER (défaut) — révèle les `earnedPoints` déjà crédités
 *     (createPointsReward, coût enveloppe = 0). C'est le comportement HISTORIQUE.
 *   • GROS LOT (rare) — un bonus EN PLUS (points bonus / cadeau / bon / code promo),
 *     coût = `unit_cost`, compté dans l'ENVELOPPE.
 *
 * ENVELOPPE (RG-06) : cible = `scratch.envelope_pct` % du panier. Le moteur suit le
 * surcoût réel moyen sur `scratch.window_days` et module les poids des gros lots
 * pour que l'espérance du surcoût par commande reste <= cible.
 */
@Injectable()
export class ScratchEngineService {
    private readonly logger = new Logger(ScratchEngineService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly settings: SettingsService,
        private readonly rewardService: RewardService,
    ) { }

    // ─────────────────────────────── CONFIG ────────────────────────────────

    private async getConfig(): Promise<ScratchConfig> {
        const [enabledRaw, pctRaw, windowRaw, floorRaw] = await Promise.all([
            this.settings.get('scratch.enabled'),
            this.settings.get('scratch.envelope_pct'),
            this.settings.get('scratch.window_days'),
            this.settings.get('scratch.floor_weight'),
        ]);
        return {
            // Défaut activé : un réglage absent ne doit PAS désactiver le grattage.
            enabled: enabledRaw === null || enabledRaw.trim() === '' ? true : enabledRaw === 'true',
            envelopePct: this.numOr(pctRaw, 4),
            windowDays: this.numOr(windowRaw, 30),
            // Plancher ≥ 1 : un poids de plancher nul casserait la garantie du plancher
            // (division par 0 dans l'enveloppe + gros lots servis quasi-systématiquement).
            floorWeight: Math.max(1, this.numOr(floorRaw, 1000)),
        };
    }

    private numOr(raw: string | null, def: number): number {
        if (raw === null || raw.trim() === '') return def;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : def;
    }

    // ──────────────────────────── TIRAGE (commande) ─────────────────────────

    /**
     * Produit le tirage d'une commande payée. IDEMPOTENT par order_id : un
     * ScratchDraw existe au plus une fois par commande (index unique DB), donc un
     * rejeu (retry BullMQ, double backend) NE re-tire PAS. Renvoie le tirage existant.
     *
     * ⚠️ Appelé dans le bloc EFFETS IDEMPOTENTS du listener KKiaPay : toute erreur
     * Prisma transitoire doit être RELANCÉE par l'appelant (le moteur ne l'avale pas).
     */
    async drawForOrder(params: { order: ScratchOrderInput; earnedPoints: number }) {
        const { order, earnedPoints } = params;

        // Idempotence : le TIRAGE est figé par le ScratchDraw (order_id unique) — un
        // rejeu NE re-tire JAMAIS. MAIS le ScratchDraw est commité AVANT le Reward :
        // si la création du Reward a échoué juste après (blip Neon), reward_id est
        // resté null. On RÉCONCILIE alors l'effet manquant (idempotent) au lieu de
        // retourner un tirage sans récompense.
        const existing = await this.prisma.scratchDraw.findUnique({ where: { order_id: order.id } });
        if (existing) {
            if (existing.reward_id) return existing; // vrai NO-OP : effet déjà appliqué
            return this.reconcileMissingReward(existing, order, earnedPoints);
        }

        const cfg = await this.getConfig();

        // Lots gros éligibles (si grattage activé). Sinon → plancher direct.
        const grosLots = cfg.enabled
            ? await this.findEligibleGrosLots(order, cfg.windowDays)
            : [];

        if (grosLots.length === 0) {
            return this.commitFloor(order, earnedPoints);
        }

        const realized = await this.realizedAvgCost(cfg.windowDays);
        const target = (cfg.envelopePct / 100) * order.net_amount;
        const { floorWeight, entries } = this.computeWeights(grosLots, target, realized, cfg.floorWeight);

        const pick = this.weightedPick(floorWeight, entries);
        if (!pick) {
            return this.commitFloor(order, earnedPoints);
        }

        return this.commitGros(order, pick, earnedPoints);
    }

    /**
     * RÉCONCILIATION d'un tirage dont le Reward manque (ScratchDraw commité mais
     * reward_id null — échec partiel avant le backfill). NE RE-TIRE PAS : le tirage
     * est déjà figé par le ScratchDraw. On recrée UNIQUEMENT l'effet manquant,
     * idempotently, puis on backfille reward_id.
     *   • Plancher (scratch_lot_id null) → createPointsReward(earnedPoints) (idempotent
     *     par order_id).
     *   • Gros lot (scratch_lot_id renseigné) → le stock a déjà été claim au 1er
     *     passage ; on recrée seulement le Reward du lot (sans re-claim ni nouveau
     *     tirage). Réutilise un Reward déjà créé pour cette commande s'il existe.
     */
    private async reconcileMissingReward(
        draw: ScratchDraw,
        order: ScratchOrderInput,
        earnedPoints: number,
    ) {
        if (!draw.scratch_lot_id) {
            const reward = await this.rewardService.createPointsReward({
                customer_id: order.customer_id,
                points: earnedPoints,
                order_id: order.id,
                reason: `Commande #${order.reference}`,
            });
            if (!reward) return draw; // 0 point → pas de Reward à lier (no-op)
            return this.prisma.scratchDraw.update({
                where: { id: draw.id },
                data: { reward_id: reward.id },
            });
        }

        const lot = await this.prisma.scratchLot.findUnique({ where: { id: draw.scratch_lot_id } });
        if (!lot) return draw; // lot supprimé entre-temps → rien à reconstituer

        // Réconciliation ATOMIQUE : verrou de ligne (FOR UPDATE) sur le tirage pour
        // sérialiser deux réconciliations concurrentes (double backend / rejeu). Sans
        // ce verrou, chacune verrait reward_id=null et créerait un Reward → double gros lot.
        return this.prisma.$transaction(async (tx) => {
            const locked = await tx.$queryRaw<{ reward_id: string | null }[]>`
                SELECT reward_id FROM "ScratchDraw" WHERE id = ${draw.id}::uuid FOR UPDATE`;
            const already = locked[0]?.reward_id;
            if (already) return { ...draw, reward_id: already }; // déjà réconcilié par un concurrent

            // Réutilise UNIQUEMENT un Reward du grattage encore PENDING pour cette commande
            // (jamais un cadeau GIFT déjà consommé au panier, ni un reward gratté d'une
            // autre source) → évite de relier le mauvais reward.
            const existingReward = await tx.reward.findFirst({
                where: { order_id: order.id, type: lot.reward_type, status: RewardStatus.PENDING },
            });
            const reward = existingReward ?? (await this.createRewardFromLot(lot, order, tx));
            await tx.scratchDraw.update({
                where: { id: draw.id },
                data: { reward_id: reward.id },
            });
            return { ...draw, reward_id: reward.id };
        });
    }

    /**
     * Sert le lot PLANCHER : crée le Reward POINTS des points déjà gagnés
     * (idempotent par order_id, comportement historique) + trace le tirage à coût 0.
     * Le ScratchDraw sert de GATE d'idempotence (order_id unique).
     */
    private async commitFloor(order: ScratchOrderInput, earnedPoints: number) {
        const draw = await this.claimDraw({ order, scratch_lot_id: null, cost: 0 });
        if (!draw.owned) return draw.draw; // course perdue → tirage existant

        const reward = await this.rewardService.createPointsReward({
            customer_id: order.customer_id,
            points: earnedPoints,
            order_id: order.id,
            reason: `Commande #${order.reference}`,
        });
        if (reward) {
            await this.prisma.scratchDraw.update({
                where: { id: draw.draw.id },
                data: { reward_id: reward.id },
            });
        }
        return draw.draw;
    }

    /**
     * Sert un GROS lot : claim de stock atomique, création du Reward correspondant
     * (via le système Reward existant, PENDING → à gratter côté app), et trace le
     * tirage avec son coût d'enveloppe. Ne touche JAMAIS addPoints (points de base).
     * Si le stock est épuisé entre-temps (course) → repli sur le plancher.
     */
    private async commitGros(order: ScratchOrderInput, pick: WeightedEntry, earnedPoints: number) {
        const lot = pick.lot;

        const draw = await this.claimDraw({ order, scratch_lot_id: lot.id, cost: lot.unit_cost });
        if (!draw.owned) return draw.draw; // course perdue → tirage existant

        // Claim de stock ATOMIQUE (updateMany conditionné) : évite la survente sous
        // concurrence. Si épuisé, on n'a pas encore créé de Reward → repli plancher.
        if (lot.stock !== null) {
            const claim = await this.prisma.scratchLot.updateMany({
                where: { id: lot.id, stock_used: { lt: lot.stock } },
                data: { stock_used: { increment: 1 }, updated_at: new Date() },
            });
            if (claim.count === 0) {
                // Stock raté → le tirage bascule en plancher (coût 0, sans lot).
                await this.prisma.scratchDraw.update({
                    where: { id: draw.draw.id },
                    data: { scratch_lot_id: null, cost: 0 },
                });
                const reward = await this.rewardService.createPointsReward({
                    customer_id: order.customer_id,
                    points: earnedPoints, // repli plancher → on révèle les points RÉELS de la commande
                    order_id: order.id,
                    reason: `Commande #${order.reference}`,
                });
                if (reward) {
                    await this.prisma.scratchDraw.update({
                        where: { id: draw.draw.id },
                        data: { reward_id: reward.id },
                    });
                }
                return this.prisma.scratchDraw.findUnique({ where: { id: draw.draw.id } });
            }
        } else {
            // Stock illimité : compteur informatif (best-effort).
            await this.prisma.scratchLot.update({
                where: { id: lot.id },
                data: { stock_used: { increment: 1 } },
            });
        }

        const reward = await this.createRewardFromLot(lot, order);
        await this.prisma.scratchDraw.update({
            where: { id: draw.draw.id },
            data: { reward_id: reward.id },
        });
        this.logger.log(
            `Gratte & Gagne : gros lot « ${lot.label} » (${lot.reward_type}) attribué ` +
            `pour la commande #${order.reference} (coût enveloppe ${lot.unit_cost} FCFA).`,
        );
        return this.prisma.scratchDraw.findUnique({ where: { id: draw.draw.id } });
    }

    /**
     * Pose le ScratchDraw comme GATE d'idempotence (order_id unique). Renvoie
     * `owned:true` si on a créé la ligne (droit d'exécuter les effets), `owned:false`
     * si une course a déjà tiré cette commande (on renvoie le tirage existant).
     */
    private async claimDraw(params: {
        order: ScratchOrderInput;
        scratch_lot_id: string | null;
        cost: number;
    }): Promise<{ owned: boolean; draw: any }> {
        try {
            const draw = await this.prisma.scratchDraw.create({
                data: {
                    order_id: params.order.id,
                    customer_id: params.order.customer_id,
                    scratch_lot_id: params.scratch_lot_id,
                    cost: params.cost,
                },
            });
            return { owned: true, draw };
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const raced = await this.prisma.scratchDraw.findUnique({
                    where: { order_id: params.order.id },
                });
                return { owned: false, draw: raced };
            }
            throw error;
        }
    }

    /**
     * Crée le Reward correspondant à un gros lot (PENDING → à gratter côté app).
     * Le `payload` est déjà validé/snapshotté par ScratchLotService à la config du lot.
     * `order_id` est renseigné → la révocation (annulation de commande) le gère via
     * `RewardService.revokeForOrder`. Un seul Reward par commande (un tirage), donc
     * pas de conflit avec l'index unique partiel Reward(order_id) WHERE type=POINTS.
     */
    private async createRewardFromLot(lot: ScratchLot, order: ScratchOrderInput, client: any = this.prisma) {
        return client.reward.create({
            data: {
                customer_id: order.customer_id,
                type: lot.reward_type,
                status: RewardStatus.PENDING,
                payload: lot.payload as Prisma.InputJsonValue,
                reason: `🎉 ${lot.label} — commande #${order.reference}`,
                order_id: order.id,
            },
        });
    }

    // ──────────────────────────── ÉLIGIBILITÉ ──────────────────────────────

    /**
     * Gros lots éligibles pour une commande : actifs, non-plancher, panier suffisant
     * (RG-09), stock disponible, niveau atteint, plafond de fréquence par client OK.
     */
    private async findEligibleGrosLots(order: ScratchOrderInput, windowDays: number): Promise<ScratchLot[]> {
        const level = order.customer?.loyalty_level ?? null;
        const lots = await this.prisma.scratchLot.findMany({
            where: {
                active: true,
                is_floor: false,
                min_cart: { lte: Math.floor(order.net_amount) },
            },
        });

        // Filtre stock + niveau (in-memory : peu de lots).
        const levelRank = level ? LEVEL_RANK[level] : 0;
        const stockOk = lots.filter(
            (l) =>
                (l.stock === null || l.stock_used < l.stock) &&
                (l.level_min === null || levelRank >= LEVEL_RANK[l.level_min]),
        );
        if (stockOk.length === 0) return [];

        // Plafond de fréquence par client sur la fenêtre : on ne compte que les lots
        // ayant un cap. 1 seule requête groupBy pour tous les lots concernés.
        const capped = stockOk.filter((l) => l.frequency_cap !== null);
        if (capped.length === 0) return stockOk;

        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const counts = await this.prisma.scratchDraw.groupBy({
            by: ['scratch_lot_id'],
            where: {
                customer_id: order.customer_id,
                scratch_lot_id: { in: capped.map((l) => l.id) },
                created_at: { gte: since },
            },
            _count: { _all: true },
        });
        const countByLot = new Map<string, number>(
            counts.map((c) => [c.scratch_lot_id as string, c._count._all]),
        );
        return stockOk.filter((l) => {
            if (l.frequency_cap === null) return true;
            return (countByLot.get(l.id) ?? 0) < l.frequency_cap;
        });
    }

    // ───────────────────────────── ENVELOPPE ───────────────────────────────

    /** Surcoût moyen réalisé par commande sur la fenêtre (moyenne des ScratchDraw.cost). */
    private async realizedAvgCost(windowDays: number): Promise<number> {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const agg = await this.prisma.scratchDraw.aggregate({
            where: { created_at: { gte: since } },
            _avg: { cost: true },
        });
        return agg._avg.cost ?? 0;
    }

    /**
     * Module les poids des gros lots pour tenir l'enveloppe :
     *   1) factor = clamp((cible − réalisé) / cible, 0, 1) — throttle sur la fenêtre
     *      (les gros lots se raréfient à mesure que le réalisé approche la cible).
     *   2) borne DURE de l'espérance à la cible, en FORME CLOSE.
     * Le plancher garde un poids implicite ÉLEVÉ (les gros lots restent rares).
     *
     * Forme close (fix enveloppe) — avec des poids mis à l'échelle s·wᵢ, l'espérance
     * du surcoût par commande vaut :
     *     E[cost] = (s·ΣwC) / (floor + s·Σw),  où ΣwC = Σ wᵢ·coûtᵢ, Σw = Σ wᵢ.
     * On ne module QUE si le surcoût espéré aux poids courants dépasse la cible :
     *     ΣwC / (floor + Σw) > cible  ⇔  ΣwC > cible·(floor + Σw).
     * Poser E[cost] = cible donne alors la solution EXACTE :
     *     s = (cible·floor) / (ΣwC − cible·Σw).
     * Sous la condition ci-dessus, ΣwC − cible·Σw > cible·floor > 0, donc s ∈ ]0,1[
     * (le clamp final n'est qu'une sécurité). L'ancien scale = cible/E réduisait AUSSI
     * Σw au dénominateur → l'espérance retombait SOUS la cible (garantie non tenue).
     */
    private computeWeights(
        grosLots: ScratchLot[],
        target: number,
        realized: number,
        floorWeight: number,
    ): { floorWeight: number; entries: WeightedEntry[] } {
        const factor = target <= 0 ? 0 : Math.min(1, Math.max(0, (target - realized) / target));
        let entries: WeightedEntry[] = grosLots
            .map((lot) => ({ lot, weight: lot.weight * factor, cost: lot.unit_cost }))
            .filter((e) => e.weight > 0);

        if (entries.length === 0) return { floorWeight, entries: [] };

        const sumW = entries.reduce((s, e) => s + e.weight, 0);
        const sumWC = entries.reduce((s, e) => s + e.weight * e.cost, 0);

        // Surcoût espéré > cible ⇒ mise à l'échelle des GROS lots par s (forme close).
        if (target > 0 && sumWC > target * (floorWeight + sumW)) {
            const denom = sumWC - target * sumW;
            if (denom > 0) {
                const s = Math.min(1, (target * floorWeight) / denom); // clamp ]0,1]
                if (s < 1) {
                    entries = entries.map((e) => ({ ...e, weight: e.weight * s }));
                }
            }
        }
        return { floorWeight, entries };
    }

    /**
     * Tirage pondéré parmi { plancher (floorWeight), gros lots (entries) }.
     * Renvoie `null` si le plancher est tiré, sinon l'entrée gagnante.
     * Math.random suffit (pas de reproductibilité requise).
     */
    private weightedPick(floorWeight: number, entries: WeightedEntry[]): WeightedEntry | null {
        const total = floorWeight + entries.reduce((s, e) => s + e.weight, 0);
        if (total <= 0) return null;
        let r = Math.random() * total;
        if (r < floorWeight) return null; // plancher
        r -= floorWeight;
        for (const e of entries) {
            if (r < e.weight) return e;
            r -= e.weight;
        }
        return null; // sécurité arrondis → plancher
    }

    // ─────────────────────── OUTILS ADMIN (backoffice) ─────────────────────

    /**
     * SIMULATEUR : pour un panier donné, calcule la distribution effective des
     * probabilités par lot + l'espérance de surcoût. `customerLevel` optionnel
     * (filtre de niveau). Les plafonds de fréquence par client sont IGNORÉS ici
     * (simulation générique, pas de client cible).
     */
    async simulate(amount: number, customerLevel?: LoyaltyLevel | null): Promise<ScratchDistribution> {
        const cfg = await this.getConfig();
        const realized = await this.realizedAvgCost(cfg.windowDays);
        const target = (cfg.envelopePct / 100) * amount;

        const allGros = await this.prisma.scratchLot.findMany({
            where: { active: true, is_floor: false },
        });
        const levelRank = customerLevel ? LEVEL_RANK[customerLevel] : 0;

        // Détermine l'éligibilité + le motif d'inéligibilité (pour le backoffice).
        const eligibleLots: ScratchLot[] = [];
        const ineligible: Array<{ lot: ScratchLot; reason: string }> = [];
        for (const lot of allGros) {
            if (!cfg.enabled) {
                ineligible.push({ lot, reason: 'grattage désactivé' });
                continue;
            }
            if (amount < lot.min_cart) {
                ineligible.push({ lot, reason: `panier < ${lot.min_cart}` });
                continue;
            }
            if (lot.stock !== null && lot.stock_used >= lot.stock) {
                ineligible.push({ lot, reason: 'stock épuisé' });
                continue;
            }
            if (lot.level_min !== null && levelRank < LEVEL_RANK[lot.level_min]) {
                ineligible.push({ lot, reason: `niveau < ${lot.level_min}` });
                continue;
            }
            eligibleLots.push(lot);
        }

        const { floorWeight, entries } = cfg.enabled
            ? this.computeWeights(eligibleLots, target, realized, cfg.floorWeight)
            : { floorWeight: cfg.floorWeight, entries: [] as WeightedEntry[] };

        const totalW = floorWeight + entries.reduce((s, e) => s + e.weight, 0);
        const weightById = new Map(entries.map((e) => [e.lot.id, e.weight]));
        const expected = totalW > 0 ? entries.reduce((s, e) => s + e.weight * e.cost, 0) / totalW : 0;

        const lots = [
            ...eligibleLots.map((lot) => {
                const ew = weightById.get(lot.id) ?? 0;
                return {
                    id: lot.id,
                    label: lot.label,
                    reward_type: lot.reward_type,
                    weight: lot.weight,
                    effective_weight: ew,
                    unit_cost: lot.unit_cost,
                    probability: totalW > 0 ? ew / totalW : 0,
                    eligible: true,
                };
            }),
            ...ineligible.map(({ lot, reason }) => ({
                id: lot.id,
                label: lot.label,
                reward_type: lot.reward_type,
                weight: lot.weight,
                effective_weight: 0,
                unit_cost: lot.unit_cost,
                probability: 0,
                eligible: false,
                reason,
            })),
        ];

        return {
            amount,
            target_cost: target,
            realized_avg_cost: realized,
            expected_cost: expected,
            floor: { probability: totalW > 0 ? floorWeight / totalW : 1 },
            lots,
        };
    }

    /**
     * MONITEUR D'ENVELOPPE : surcoût moyen réalisé sur la fenêtre, nombre de tirages,
     * cible configurée et panier moyen (pour exprimer le réalisé en % du panier).
     */
    async envelopeMonitor() {
        const cfg = await this.getConfig();
        const since = new Date(Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000);

        const [drawAgg, grosCount, orderAgg] = await Promise.all([
            this.prisma.scratchDraw.aggregate({
                where: { created_at: { gte: since } },
                _avg: { cost: true },
                _sum: { cost: true },
                _count: { _all: true },
            }),
            this.prisma.scratchDraw.count({
                where: { created_at: { gte: since }, cost: { gt: 0 } },
            }),
            this.prisma.order.aggregate({
                where: { scratch_draws: { some: { created_at: { gte: since } } } },
                _avg: { amount: true },
            }),
        ]);

        const realizedAvgCost = drawAgg._avg.cost ?? 0;
        const avgBasket = orderAgg._avg.amount ?? 0;
        return {
            window_days: cfg.windowDays,
            envelope_pct_target: cfg.envelopePct,
            draws: drawAgg._count._all,
            gros_lot_draws: grosCount,
            total_cost: drawAgg._sum.cost ?? 0,
            realized_avg_cost: realizedAvgCost,
            avg_basket: avgBasket,
            realized_pct: avgBasket > 0 ? (realizedAvgCost / avgBasket) * 100 : 0,
            within_target: avgBasket > 0 ? (realizedAvgCost / avgBasket) * 100 <= cfg.envelopePct : true,
        };
    }

    // ───────────────────── RÉVOCATION (annulation commande) ─────────────────

    /**
     * Restitue le stock d'un GROS lot dont le Reward a été révoqué (commande annulée
     * AVANT grattage). No-op si le tirage était un plancher, si le lot est illimité,
     * ou si le Reward a déjà été gratté/consommé (le client a profité du lot → pas
     * de restitution). Idempotent (rejouable), appelé depuis le listener d'annulation.
     */
    async restoreStockForCancelledOrder(order_id: string) {
        const draw = await this.prisma.scratchDraw.findUnique({
            where: { order_id },
            include: { lot: true, reward: true },
        });
        if (!draw || !draw.scratch_lot_id || !draw.lot || draw.lot.stock === null) return;
        // On restitue le stock si le lot n'a PAS été gardé par le client :
        //   • Reward REVOKED (revokeForOrder l'a passé PENDING→REVOKED), OU
        //   • Reward jamais matérialisé (reward_id null après un échec partiel du
        //     commitGros qui avait déjà claim le stock) → sinon fuite de stock permanente.
        // On NE restitue PAS un lot déjà gratté/consommé (SCRATCHED/CONSUMED) ni un
        // Reward encore valide (PENDING non révoqué).
        if (draw.reward && draw.reward.status !== RewardStatus.REVOKED) return;
        // Idempotence PAR TIRAGE : un event CANCELLED rejoué ne re-décrémente pas.
        if (draw.restored_at !== null) return;

        // Claim ATOMIQUE de la restitution (garde restored_at IS NULL) : sous rejeu
        // concurrent, un seul passage passe le claim et décrémente le stock.
        const claim = await this.prisma.scratchDraw.updateMany({
            where: { id: draw.id, restored_at: null },
            data: { restored_at: new Date() },
        });
        if (claim.count === 0) return; // course perdue → déjà restitué

        await this.prisma.scratchLot.updateMany({
            where: { id: draw.scratch_lot_id, stock_used: { gt: 0 } },
            data: { stock_used: { decrement: 1 }, updated_at: new Date() },
        });
        this.logger.log(`Gratte & Gagne : stock restitué (lot ${draw.scratch_lot_id}) — commande ${order_id} annulée.`);
    }
}
