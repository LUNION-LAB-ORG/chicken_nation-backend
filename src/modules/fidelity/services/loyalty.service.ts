import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LoyaltyLevel, LoyaltyPointType, LoyaltyPointIsUsed, Customer, LoyaltyPoint, Prisma, EntityStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AddLoyaltyPointDto } from '../dto/add-loyalty-point.dto';
import { LoyaltyEvent } from '../events/loyalty.event';
import { LoyaltyQueryDto } from '../dto/loyalty-query.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { UpdateLoyaltyConfigDto } from '../dto/loyalty-config.dto';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

@Injectable()
export class LoyaltyService {
    constructor(
        private prisma: PrismaService,
        private loyaltyEvent: LoyaltyEvent,
        private readonly appGateway: AppGateway,
    ) { }


    async updateConfig(data: UpdateLoyaltyConfigDto) {
        // Valider la cohérence des seuils
        // STANDARD étant le niveau d'ENTRÉE, son seuil vaut 0 et n'est plus
        // réglable : seuls VIP et VVIP se paramètrent, et dans cet ordre.
        if (data.premium_threshold !== undefined && data.gold_threshold !== undefined) {
            if (data.premium_threshold >= data.gold_threshold) {
                throw new BadRequestException('Les seuils doivent être croissants : VIP < VVIP');
            }
        }
        if (data.premium_threshold !== undefined && data.premium_threshold <= 0) {
            throw new BadRequestException('Le seuil VIP doit être strictement positif.');
        }

        // Récupérer la config active ou en créer une
        let config = await this.prisma.loyaltyConfig.findFirst({
            where: { is_active: true }
        });

        if (config) {
            // Mise à jour
            config = await this.prisma.loyaltyConfig.update({
                where: { id: config.id },
                data: {
                    ...data,
                    updated_at: new Date()
                }
            });
        } else {
            // Création
            config = await this.prisma.loyaltyConfig.create({
                data: {
                    ...data,
                    is_active: true
                }
            });
        }

        return {
            message: 'Configuration de fidélité mise à jour avec succès',
            data: config
        };
    }

    async getConfig() {
        let config = await this.prisma.loyaltyConfig.findFirst({
            where: { is_active: true }
        });

        if (!config) {
            // Créer une configuration par défaut
            config = await this.prisma.loyaltyConfig.create({
                data: {
                    is_active: true
                }
            });
        }

        return config;
    }
    
    async getAllLoyaltyPoints(query: LoyaltyQueryDto): Promise<QueryResponseDto<LoyaltyPoint>> {
        const { page = 1, limit = 10, type, is_used, search } = query;
        const whereClause: Prisma.LoyaltyPointWhereInput = {};

        //    if (search) {
        //      whereClause.OR = [
        //        { first_name: { contains: search, mode: 'insensitive' } },
        //        { last_name: { contains: search, mode: 'insensitive' } },
        //        { phone: { contains: search } },
        //        { email: { contains: search, mode: 'insensitive' } },
        //      ];
        //    }

        if (type) {
            whereClause.type = type;
        }

        if (query.customer_id) {
            whereClause.customer_id = query.customer_id;
        }
        if (is_used && is_used !== 'all') {
            switch (is_used) {
                case 'available':
                    whereClause.is_used = LoyaltyPointIsUsed.NO;
                    break;
                case 'used':
                    whereClause.is_used = LoyaltyPointIsUsed.YES;
                    break;
                case 'partial':
                    whereClause.is_used = LoyaltyPointIsUsed.PARTIAL;
                    break;
            }
        }

        const take = limit ?? 20;
        const skip = page ? (page - 1) * take : 0;

        const [loyaltyPoints, total] = await Promise.all([
            this.prisma.loyaltyPoint.findMany({
                where: whereClause,
                include: {
                    customer: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            email: true,
                            phone: true,
                            image: true,

                        }
                    },
                    order: {
                        select: {
                            id: true,

                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                take,
                skip,
            }),
            this.prisma.loyaltyPoint.count({ where: whereClause }),
        ]);

        return {
            data: loyaltyPoints,
            meta: {
                total,
                page: page,
                limit: take,
                totalPages: Math.ceil(total / take),
            },
        };
    }
    // Ajouter des points bonus ou gagnés
    async addPoints({ customer_id, points, type, reason, order_id }: AddLoyaltyPointDto) {
        const config = await this.getConfig();

        if (type !== LoyaltyPointType.EARNED && type !== LoyaltyPointType.BONUS) {
            throw new BadRequestException('Type de point requis');
        }

        const customer = await this.prisma.customer.findUnique({
            where: { id: customer_id }
        });

        if (!customer) {
            throw new NotFoundException('Client non trouvé');
        }

        // Idempotence : une commande (order_id) ne GAGNE des points qu'une seule
        // fois — événement rejoué, double backend, ou double câblage
        // (création PENDING puis COMPLETED). Sans ce garde-fou, le solde
        // gonflerait à chaque ré-émission. Les gains sans order_id (bonus manuel)
        // ne sont pas concernés.
        if (order_id) {
            const existing = await this.prisma.loyaltyPoint.findFirst({
                where: {
                    order_id,
                    type: { in: [LoyaltyPointType.EARNED, LoyaltyPointType.BONUS] },
                },
            });
            if (existing) {
                return existing;
            }
        }

        try {
            return await this.prisma.$transaction(async (tx) => {
                // Ajouter les points
                const loyaltyPoint = await tx.loyaltyPoint.create({
                    data: {
                        customer_id,
                        points,
                        type,
                        reason,
                        order_id,
                        expires_at: new Date(Date.now() + config.points_expiration_days! * 24 * 60 * 60 * 1000)
                    }
                });

                // Mettre à jour les points du client.
                // status_points (compteur ANNUEL adossé au NIVEAU) n'est incrémenté
                // QUE pour les gains de commande (EARNED). Les BONUS de palier (et
                // autres crédits manuels) ne comptent PAS pour le statut — sinon le
                // bonus attribué à un changement de niveau ferait cascader les niveaux.
                await tx.customer.update({
                    where: { id: customer_id },
                    data: {
                        total_points: { increment: points },
                        lifetime_points: { increment: points },
                        ...(type === LoyaltyPointType.EARNED
                            ? { status_points: { increment: points } }
                            : {}),
                    }
                });


                // Vérifier et mettre à jour le niveau de fidélité
                await this.updateCustomerLoyaltyLevel(customer, tx);

                // Evenement d'ajout de points
                this.loyaltyEvent.addPointsEvent({
                    customer,
                    points,
                });

                // WebSocket: notifier le client de ses nouveaux points
                this.appGateway.emitToUser(customer_id, 'customer', 'loyalty:points_added', {
                    points,
                    type,
                    reason,
                    newTotal: customer.total_points + points,
                });
                this.appGateway.emitToBackoffice('loyalty:points_added', {
                    customerId: customer_id,
                    points,
                    type,
                    reason,
                });

                return loyaltyPoint;
            });
        } catch (error) {
            // FILET D'IDEMPOTENCE au niveau DB : l'index unique partiel
            // LoyaltyPoint(order_id) WHERE type IN ('EARNED','BONUS') (migration
            // 20260714120000) empêche un double-crédit sous concurrence (retry
            // BullMQ, double backend, futur cron de réconciliation) que le
            // find-then-create applicatif ci-dessus ne couvre pas seul. Une
            // violation P2002 signifie « déjà crédité » → NO-OP : on renvoie la
            // ligne existante (la transaction a été ANNULÉE, donc aucun incrément
            // parasite sur le client). Toute autre erreur est propagée.
            if (
                order_id &&
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                const existing = await this.prisma.loyaltyPoint.findFirst({
                    where: {
                        order_id,
                        type: { in: [LoyaltyPointType.EARNED, LoyaltyPointType.BONUS] },
                    },
                });
                if (existing) return existing;
            }
            throw error;
        }
    }

    // Calculer les points pour une commande
    async calculatePointsForOrder(order_amount: number): Promise<number> {
        const config = await this.getConfig();

        if (!order_amount) {
            throw new BadRequestException('Montant de la commande requis');
        }

        return Math.floor(order_amount * config.points_per_xof);
    }

    // Calculer le montant pour une commande
    async calculateAmountForPoints(points: number): Promise<number> {
        const config = await this.getConfig();

        if (!points) {
            return 0;
        }

        return Math.floor(points * config.point_value_in_xof);
    }

    // Utiliser des points
    async redeemPoints({ customer_id, points, reason, order_id }: Omit<AddLoyaltyPointDto, 'type'>) {
        const config = await this.getConfig();

        // Idempotence : si cette commande a déjà consommé des points, on ne déduit
        // pas une seconde fois (ré-acceptation, événement rejoué, double backend…).
        // Le rachat reste ainsi lié à la commande et jamais dupliqué.
        if (order_id) {
            const existing = await this.prisma.loyaltyPoint.findFirst({
                where: { order_id, type: LoyaltyPointType.REDEEMED },
            });
            if (existing) {
                return {
                    redemption_record: existing,
                    used_points_details: [],
                    total_points_used: existing.points,
                    already_redeemed: true,
                };
            }
        }

        if (points < config.minimum_redemption_points) {
            throw new BadRequestException(`Minimum ${config.minimum_redemption_points} points requis pour utiliser`);
        }

        const customer = await this.prisma.customer.findUnique({
            where: { id: customer_id }
        });

        if (!customer || customer.total_points < points) {
            throw new BadRequestException('Points insuffisants');
        }

        const payload = await this.prisma.$transaction(async (tx) => {
            let remainingPointsToUse = points;
            const usedPointsDetails: any[] = [];

            // 1. Utiliser d'abord les points BONUS (par ordre de création/expiration)
            const bonusPoints = await tx.loyaltyPoint.findMany({
                where: {
                    customer_id,
                    type: LoyaltyPointType.BONUS,
                    is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                    OR: [
                        { expires_at: null },
                        { expires_at: { gt: new Date() } }
                    ]
                },
                orderBy: [
                    { expires_at: 'asc' }, // Les plus proches de l'expiration d'abord
                    { created_at: 'asc' }
                ]
            });

            for (const bonusPoint of bonusPoints) {
                if (remainingPointsToUse <= 0) break;

                const availablePoints = bonusPoint.points - (bonusPoint.points_used || 0);
                const pointsToUse = Math.min(remainingPointsToUse, availablePoints);

                if (pointsToUse > 0) {
                    const newPointsUsed = (bonusPoint.points_used || 0) + pointsToUse;
                    const newIsUsed = newPointsUsed >= bonusPoint.points ? LoyaltyPointIsUsed.YES : LoyaltyPointIsUsed.PARTIAL;

                    await tx.loyaltyPoint.update({
                        where: { id: bonusPoint.id },
                        data: {
                            points_used: newPointsUsed,
                            is_used: newIsUsed
                        }
                    });

                    usedPointsDetails.push({
                        point_id: bonusPoint.id,
                        type: LoyaltyPointType.BONUS,
                        points_used: pointsToUse,
                        points_remaining: bonusPoint.points - newPointsUsed
                    });

                    remainingPointsToUse -= pointsToUse;
                }
            }

            // 2. Si les bonus ne suffisent pas, utiliser les points EARNED
            if (remainingPointsToUse > 0) {
                const earnedPoints = await tx.loyaltyPoint.findMany({
                    where: {
                        customer_id,
                        type: LoyaltyPointType.EARNED,
                        is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                        OR: [
                            { expires_at: null },
                            { expires_at: { gt: new Date() } }
                        ]
                    },
                    orderBy: [
                        { expires_at: 'asc' }, // Les plus proches de l'expiration d'abord
                        { created_at: 'asc' }
                    ]
                });

                for (const earnedPoint of earnedPoints) {
                    if (remainingPointsToUse <= 0) break;

                    const availablePoints = earnedPoint.points - (earnedPoint.points_used || 0);
                    const pointsToUse = Math.min(remainingPointsToUse, availablePoints);

                    if (pointsToUse > 0) {
                        const newPointsUsed = (earnedPoint.points_used || 0) + pointsToUse;
                        const newIsUsed = newPointsUsed >= earnedPoint.points ? LoyaltyPointIsUsed.YES : LoyaltyPointIsUsed.PARTIAL;

                        await tx.loyaltyPoint.update({
                            where: { id: earnedPoint.id },
                            data: {
                                points_used: newPointsUsed,
                                is_used: newIsUsed
                            }
                        });

                        usedPointsDetails.push({
                            point_id: earnedPoint.id,
                            type: LoyaltyPointType.EARNED,
                            points_used: pointsToUse,
                            points_remaining: earnedPoint.points - newPointsUsed
                        });

                        remainingPointsToUse -= pointsToUse;
                    }
                }
            }

            // Vérification finale
            if (remainingPointsToUse > 0) {
                throw new BadRequestException('Points insuffisants disponibles');
            }

            // Créer l'enregistrement de rachat
            const redemptionRecord = await tx.loyaltyPoint.create({
                data: {
                    customer_id,
                    order_id,
                    points,
                    type: LoyaltyPointType.REDEEMED,
                    reason,
                    points_used: points,
                    is_used: LoyaltyPointIsUsed.YES
                }
            });

            // Mettre à jour les points du client
            await tx.customer.update({
                where: { id: customer_id },
                data: {
                    total_points: { decrement: points }
                }
            });

            // Vérifier et mettre à jour le niveau de fidélité
            await this.updateCustomerLoyaltyLevel(customer, tx);

            return {
                redemption_record: redemptionRecord,
                used_points_details: usedPointsDetails,
                total_points_used: points,
            };
        });

        // Evenement de rachat de points
        this.loyaltyEvent.redeemPointsEvent({
            customer,
            points,
        });

        // WebSocket: notifier le client
        this.appGateway.emitToUser(customer_id, 'customer', 'loyalty:points_redeemed', {
            pointsUsed: points,
            newTotal: customer.total_points - points,
        });
        this.appGateway.emitToBackoffice('loyalty:points_redeemed', {
            customerId: customer_id,
            pointsUsed: points,
        });

        return payload;
    }

    /**
     * Révoque les points GAGNÉS (EARNED) d'une commande — typiquement à son
     * ANNULATION. On ne reprend que la part ENCORE DISPONIBLE (`points - points_used`) :
     * si le client a déjà dépensé une partie, on ne peut pas la reprendre. Le record
     * EARNED passe en EXPIRED (retiré des points disponibles) avec le motif d'annulation.
     * Idempotent : une 2e passe ne trouve plus de EARNED actif pour la commande.
     * `lifetime_points` n'est PAS décrémenté (évite un déclassement de niveau).
     */
    async revokeEarnedPointsForOrder(order_id: string, reason: string) {
        const earnedPoints = await this.prisma.loyaltyPoint.findMany({
            where: {
                order_id,
                type: LoyaltyPointType.EARNED,
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
            },
        });

        if (earnedPoints.length === 0) {
            return { revoked_records: 0, points_revoked: 0 };
        }

        let pointsRevoked = 0;
        let customer_id: string | null = null;

        for (const point of earnedPoints) {
            const remaining = point.points - (point.points_used || 0);
            if (remaining <= 0) continue;
            customer_id = point.customer_id;

            await this.prisma.$transaction(async (tx) => {
                await tx.loyaltyPoint.update({
                    where: { id: point.id },
                    data: {
                        type: LoyaltyPointType.EXPIRED,
                        is_used: LoyaltyPointIsUsed.YES,
                        reason,
                    },
                });
                await tx.customer.update({
                    where: { id: point.customer_id },
                    data: { total_points: { decrement: remaining } },
                });
            });

            pointsRevoked += remaining;
        }

        // WebSocket : rafraîchir le solde côté client + backoffice.
        if (customer_id && pointsRevoked > 0) {
            this.appGateway.emitToUser(customer_id, 'customer', 'loyalty:points_redeemed', {
                pointsUsed: pointsRevoked,
                reason,
            });
            this.appGateway.emitToBackoffice('loyalty:points_redeemed', {
                customerId: customer_id,
                pointsUsed: pointsRevoked,
            });
        }

        return { revoked_records: earnedPoints.length, points_revoked: pointsRevoked };
    }

    /**
     * Réconciliation des déductions de points MANQUÉES (fuite historique).
     *
     * Contexte : pendant longtemps la déduction n'était câblée que sur la transition
     * ACCEPTED. Les commandes « À livrer » / Turbo « workflow manuel » atteignant TERMINÉE
     * sans passer par ACCEPTED ont donc GAGNÉ des points sans jamais en CONSOMMER → soldes
     * gonflés. Cette routine corrige l'historique.
     *
     * Cible : commandes COMPLETED avec `points > 0` SANS aucune ligne LoyaltyPoint REDEEMED.
     * - dryRun (DÉFAUT) : ne mute RIEN. Renvoie le diagnostic (nb commandes, clients,
     *   total de points à déduire, échantillon).
     * - apply : appelle `redeemPoints` commande par commande. redeemPoints est idempotent
     *   par order_id (re-jouable sans risque) et refuse de passer un solde négatif
     *   (« Points insuffisants ») → les cas limites sont remontés en `failures`, jamais forcés.
     *
     * ⚠️ À lancer UNE SEULE FOIS, sur UN SEUL backend (cf. course double backend).
     */
    async reconcileRedemptions({
        dryRun = true,
        limit,
    }: { dryRun?: boolean; limit?: number } = {}) {
        const candidates = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.COMPLETED,
                points: { gt: 0 },
                loyalty_points: { none: { type: LoyaltyPointType.REDEEMED } },
            },
            select: {
                id: true,
                reference: true,
                customer_id: true,
                points: true,
            },
            orderBy: { created_at: 'asc' }, // chronologique : FIFO de consommation cohérent
            ...(limit ? { take: limit } : {}),
        });

        const totalPointsToDeduct = candidates.reduce((s, o) => s + o.points, 0);
        const affectedCustomers = new Set(candidates.map((o) => o.customer_id)).size;

        if (dryRun) {
            return {
                dry_run: true,
                candidate_orders: candidates.length,
                affected_customers: affectedCustomers,
                total_points_to_deduct: totalPointsToDeduct,
                sample: candidates.slice(0, 20).map((o) => ({
                    reference: o.reference,
                    customer_id: o.customer_id,
                    points: o.points,
                })),
            };
        }

        const result = {
            dry_run: false,
            candidate_orders: candidates.length,
            settled: 0,
            already_redeemed: 0,
            failed: 0,
            points_deducted: 0,
            failures: [] as { reference: string; customer_id: string; points: number; error: string }[],
        };

        for (const o of candidates) {
            try {
                const r: any = await this.redeemPoints({
                    customer_id: o.customer_id,
                    points: o.points,
                    order_id: o.id,
                    reason: `🔧 Réconciliation : ${o.points} points utilisés pour la commande #${o.reference} (déduction historique manquée)`,
                });
                if (r?.already_redeemed) {
                    result.already_redeemed++;
                } else {
                    result.settled++;
                    result.points_deducted += o.points;
                }
            } catch (error) {
                result.failed++;
                result.failures.push({
                    reference: o.reference,
                    customer_id: o.customer_id,
                    points: o.points,
                    error: error?.message ?? 'erreur inconnue',
                });
            }
        }

        return result;
    }

    /**
     * BACKFILL des niveaux de fidélité (`loyalty_level`) des clients EXISTANTS.
     *
     * Contexte : le niveau n'est (re)calculé que lors d'un gain/dépense de points
     * (`updateCustomerLoyaltyLevel`). Les clients créés/importés avant ce câblage —
     * ou qui n'ont plus bougé depuis — gardent `loyalty_level = null` et s'affichent
     * « NOUVEAU » alors que leur `status_points` leur donne droit à un palier. Cette
     * routine recalcule le NIVEAU attendu depuis `status_points` + seuils de la config
     * active (via `computeLoyaltyLevel`, même logique que le temps réel) et corrige
     * le champ.
     *
     * ⚠️ Ne recalcule QUE `loyalty_level`. Ne touche NI aux points
     * (total/lifetime/status), NI aux bonus de palier, NI à `last_level_update`,
     * NI à l'historique, NI aux événements/WS. Simple rattrapage d'affichage.
     *
     * - dryRun (DÉFAUT) : ne mute RIEN. Compte/liste ce qui CHANGERAIT.
     * - apply : applique les UPDATE, uniquement là où le niveau attendu (non-null)
     *   diffère de l'actuel. On n'écrase JAMAIS un niveau existant par null
     *   (status_points sous le seuil Standard) → cohérent avec
     *   `updateCustomerLoyaltyLevel` qui ne rétrograde jamais vers « aucun palier ».
     *   UPDATE conditionné sur le niveau observé (claim atomique) : idempotent et
     *   sans risque si un client change de niveau en temps réel pendant la passe.
     */
    async backfillLoyaltyLevels({
        dryRun = true,
        limit,
    }: { dryRun?: boolean; limit?: number } = {}) {
        const config = await this.getConfig();

        const customers = await this.prisma.customer.findMany({
            where: { entity_status: EntityStatus.ACTIVE },
            select: { id: true, loyalty_level: true, status_points: true },
            orderBy: { created_at: 'asc' },
            ...(limit ? { take: limit } : {}),
        });

        // Répartition des corrections par niveau CIBLE (STANDARD/VIP/VVIP).
        const byLevel: Record<LoyaltyLevel, number> = {
            [LoyaltyLevel.STANDARD]: 0,
            [LoyaltyLevel.VIP]: 0,
            [LoyaltyLevel.VVIP]: 0,
        };
        const toChange: {
            id: string;
            from: LoyaltyLevel | null;
            to: LoyaltyLevel;
        }[] = [];

        for (const c of customers) {
            const expected = this.computeLoyaltyLevel(c.status_points, config);
            // On ne corrige que vers un palier RÉEL (non-null) différent de l'actuel.
            // Un niveau attendu null (sous le seuil Standard) est laissé tel quel :
            // on ne rétrograde pas un client existant vers « NOUVEAU ».
            if (expected && expected !== c.loyalty_level) {
                toChange.push({ id: c.id, from: c.loyalty_level, to: expected });
                byLevel[expected]++;
            }
        }

        if (dryRun) {
            return {
                dry_run: true,
                scanned: customers.length,
                would_change: toChange.length,
                by_level: byLevel,
                sample: toChange.slice(0, 20),
            };
        }

        let changed = 0;
        for (const ch of toChange) {
            // UPDATE ciblé du SEUL champ loyalty_level, conditionné sur le niveau
            // observé (updateMany → 0 ligne si le client a bougé entre-temps, aucun
            // throw si supprimé). Aucun autre champ n'est modifié.
            const res = await this.prisma.customer.updateMany({
                where: { id: ch.id, loyalty_level: ch.from },
                data: { loyalty_level: ch.to },
            });
            changed += res.count;
        }

        return {
            dry_run: false,
            scanned: customers.length,
            changed,
            by_level: byLevel,
        };
    }

    // Obtenir les informations de fidélité d'un client
    async getCustomerLoyaltyInfo(customer_id: string) {
        const customer = await this.prisma.customer.findUnique({
            where: { id: customer_id },
            include: {
                loyalty_points: {
                    orderBy: { created_at: 'desc' },
                    take: 10
                },
                loyalty_level_history: {
                    orderBy: { created_at: 'desc' },
                    take: 5
                }
            }
        });

        if (!customer) {
            throw new NotFoundException('Client non trouvé');
        }

        const config = await this.getConfig();

        // Calculer le prochain niveau et les points nécessaires
        let nextLevel: LoyaltyLevel | null = null;
        let pointsToNextLevel = 0;

        // Le NIVEAU est adossé au compteur ANNUEL status_points (pas lifetime_points).
        // STANDARD est le niveau d'ENTRÉE : un `loyalty_level` encore null en base
        // (client antérieur au backfill) est traité comme STANDARD.
        const effectiveLevel = customer.loyalty_level ?? LoyaltyLevel.STANDARD;
        switch (effectiveLevel) {
            case LoyaltyLevel.VIP:
                nextLevel = LoyaltyLevel.VVIP;
                pointsToNextLevel = config.gold_threshold - customer.status_points;
                break;
            case LoyaltyLevel.VVIP:
                nextLevel = null;
                pointsToNextLevel = 0;
                break;
            default: // STANDARD
                nextLevel = LoyaltyLevel.VIP;
                pointsToNextLevel = config.premium_threshold - customer.status_points;
                break;
        }

        // Calculer les points disponibles par type
        const availablePointsByType = await this.prisma.loyaltyPoint.groupBy({
            by: ['type'],
            where: {
                customer_id,
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                OR: [
                    { expires_at: null },
                    { expires_at: { gt: new Date() } }
                ]
            },
            _sum: {
                points: true,
                points_used: true
            }
        });

        const pointsBreakdown = availablePointsByType.map(group => ({
            type: group.type,
            total_points: group._sum.points || 0,
            used_points: group._sum.points_used || 0,
            available_points: (group._sum.points || 0) - (group._sum.points_used || 0)
        }));

        return {
            customer_id: customer.id,
            // Jamais null : STANDARD est le niveau d'entrée (les lignes encore
            // à null en base sont vues comme STANDARD, comme le fait le calcul).
            current_level: effectiveLevel,
            // ⚠️ SOURCE DE VÉRITÉ du niveau — doit être exposée : sans elle, les
            // écrans reconstituaient le compteur à partir des seuils et
            // fabriquaient des valeurs fausses (carte « 300/300 pts » pour un
            // client à 0 point).
            status_points: customer.status_points,
            // Seuils renvoyés avec la donnée : un écran n'a plus à les recroiser
            // avec un autre appel pour afficher une progression.
            level_thresholds: {
                STANDARD: config.standard_threshold,
                VIP: config.premium_threshold,
                VVIP: config.gold_threshold,
            },
            total_points: customer.total_points,
            lifetime_points: customer.lifetime_points,
            next_level: nextLevel,
            points_to_next_level: Math.max(0, pointsToNextLevel),
            points_breakdown: pointsBreakdown,
            recent_points: customer.loyalty_points,
            level_history: customer.loyalty_level_history,
            points_value_in_xof: customer.total_points * config.point_value_in_xof
        };
    }

    /**
     * Déduit le NIVEAU de fidélité à partir du compteur ANNUEL `status_points`
     * et des seuils de la config active. Renvoie `null` sous le seuil Standard
     * (aucun palier atteint → « NOUVEAU »). SOURCE DE VÉRITÉ UNIQUE du calcul de
     * niveau, réutilisée par `updateCustomerLoyaltyLevel` (temps réel, au
     * gain/dépense) ET par `backfillLoyaltyLevels` (rattrapage des clients
     * existants). Toute évolution des paliers se fait ICI, à un seul endroit.
     */
    private computeLoyaltyLevel(
        statusPoints: number,
        config: {
            standard_threshold: number;
            premium_threshold: number;
            gold_threshold: number;
        },
    ): LoyaltyLevel {
        if (statusPoints >= config.gold_threshold) return LoyaltyLevel.VVIP;
        if (statusPoints >= config.premium_threshold) return LoyaltyLevel.VIP;
        // STANDARD est le niveau d'ENTRÉE (décision 23/07) : tout client en fait
        // partie dès l'inscription, ce qui colle aux cartes déjà imprimées et
        // supprime l'état « NOUVEAU » qui n'existait que dans les écrans.
        return LoyaltyLevel.STANDARD;
    }

    // Mettre à jour le niveau de fidélité d'un client
    private async updateCustomerLoyaltyLevel(customer: Customer, tx: any) {
        const config = await this.getConfig();

        // Re-lecture DANS la transaction : le `customer` reçu en argument est
        // capturé AVANT l'incrément (addPoints) → il porte des compteurs périmés.
        // On lit l'état frais pour décider le niveau sur le status_points À JOUR.
        const fresh = await tx.customer.findUnique({
            where: { id: customer.id },
            select: {
                id: true,
                loyalty_level: true,
                status_points: true,
                total_points: true,
                lifetime_points: true,
            },
        });
        if (!fresh) return;

        // Le NIVEAU est calculé sur le compteur ANNUEL status_points.
        const newLevel = this.computeLoyaltyLevel(fresh.status_points, config);

        if (newLevel && newLevel !== fresh.loyalty_level) {
            // Ordre des niveaux : distingue une MONTÉE d'une rétrogradation (ex. après
            // un relèvement des seuils en config). Le bonus + la célébration level_up ne
            // se déclenchent QUE sur une progression réelle ; le niveau, lui, est ajusté
            // dans les deux sens et l'historique tracé.
            const levelRank = (lvl: LoyaltyLevel | null): number =>
                lvl === LoyaltyLevel.VVIP ? 3
                    : lvl === LoyaltyLevel.VIP ? 2
                        : lvl === LoyaltyLevel.STANDARD ? 1
                            : 0;
            const isUpgrade = levelRank(newLevel) > levelRank(fresh.loyalty_level);

            // Montant du bonus de palier à CRÉDITER réellement — UNIQUEMENT en montée.
            let bonusPoints = 0;
            if (isUpgrade) {
                switch (newLevel) {
                    case LoyaltyLevel.STANDARD:
                        bonusPoints = 100;
                        break;
                    case LoyaltyLevel.VIP:
                        bonusPoints = 150;
                        break;
                    case LoyaltyLevel.VVIP:
                        bonusPoints = 200;
                        break;
                }
            }

            // Mettre à jour le niveau du client + CRÉDITER le bonus de palier.
            // Le bonus alimente total_points (dépensable) et lifetime_points (cumul)
            // mais PAS status_points → il ne fait pas cascader les niveaux (pas de
            // récursion : on ne rappelle pas updateCustomerLoyaltyLevel ici).
            await tx.customer.update({
                where: { id: fresh.id },
                data: {
                    loyalty_level: newLevel,
                    last_level_update: new Date(),
                    ...(bonusPoints > 0
                        ? {
                            total_points: { increment: bonusPoints },
                            lifetime_points: { increment: bonusPoints },
                        }
                        : {}),
                }
            });

            // Enregistrer le crédit du bonus dans le ledger (registre comptable).
            if (bonusPoints > 0) {
                await tx.loyaltyPoint.create({
                    data: {
                        customer_id: fresh.id,
                        order_id: null,
                        points: bonusPoints,
                        type: LoyaltyPointType.BONUS,
                        reason: `Bonus palier ${newLevel}`,
                        expires_at: new Date(
                            Date.now() + config.points_expiration_days! * 24 * 60 * 60 * 1000,
                        ),
                    },
                });
            }

            // Historique : on trace TOUT changement de niveau (montée ET ajustement).
            await tx.loyaltyLevelHistory.create({
                data: {
                    customer_id: fresh.id,
                    previous_level: fresh.loyalty_level,
                    new_level: newLevel,
                    points_at_time: fresh.status_points,
                    reason: isUpgrade
                        ? 'Montée de niveau (points de statut)'
                        : 'Ajustement de niveau (points de statut)',
                }
            });

            // Célébration (event + WS level_up) : UNIQUEMENT sur une montée réelle
            // — pas sur une rétrogradation (ex. relèvement des seuils en config).
            if (isUpgrade) {
                this.loyaltyEvent.levelUpEvent({
                    customer,
                    new_level: newLevel,
                    bonus_points: bonusPoints
                });

                this.appGateway.emitToUser(customer.id, 'customer', 'loyalty:level_up', {
                    previousLevel: fresh.loyalty_level,
                    newLevel,
                    bonusPoints,
                });
                this.appGateway.emitToBackoffice('loyalty:level_up', {
                    customerId: fresh.id,
                    previousLevel: fresh.loyalty_level,
                    newLevel,
                });
            }
        }
    }

    // Expirer les points
    async expirePoints() {
        const now = new Date();

        // Récupérer tous les points qui ne sont pas totalement utilisés et qui sont expirés
        const expiredPoints = await this.prisma.loyaltyPoint.findMany({
            where: {
                type: {
                    in: [LoyaltyPointType.EARNED, LoyaltyPointType.BONUS]
                },
                expires_at: { lt: now },
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] } // Seulement les points non totalement utilisés
            },
            include: {
                customer: true
            }
        });

        let totalExpiredPoints = 0;

        for (const point of expiredPoints) {
            await this.prisma.$transaction(async (tx) => {
                const remainingPoints = point.points - (point.points_used || 0);

                if (remainingPoints > 0) {
                    // Marquer le point comme expiré
                    await tx.loyaltyPoint.update({
                        where: { id: point.id },
                        data: {
                            type: LoyaltyPointType.EXPIRED,
                            is_used: LoyaltyPointIsUsed.YES // Marquer comme totalement "utilisé" (expiré)
                        }
                    });

                    // Décrémenter les points restants du client
                    await tx.customer.update({
                        where: { id: point.customer_id },
                        data: {
                            total_points: { decrement: remainingPoints }
                        }
                    });

                    totalExpiredPoints += remainingPoints;
                }
            });
        }

        return {
            expired_point_records: expiredPoints.length,
            total_points_expired: totalExpiredPoints
        };
    }

    // Obtenir le détail des points utilisables d'un client
    async getAvailablePointsBreakdown(customer_id: string) {
        const availablePoints = await this.prisma.loyaltyPoint.findMany({
            where: {
                customer_id,
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                type: { in: [LoyaltyPointType.EARNED, LoyaltyPointType.BONUS] },
                OR: [
                    { expires_at: null },
                    { expires_at: { gt: new Date() } }
                ]
            },
            orderBy: [
                { type: 'desc' }, // BONUS avant EARNED
                { expires_at: 'asc' }, // Les plus proches de l'expiration d'abord
                { created_at: 'asc' }
            ]
        });

        return availablePoints.map(point => ({
            id: point.id,
            type: point.type,
            total_points: point.points,
            used_points: point.points_used || 0,
            available_points: point.points - (point.points_used || 0),
            expires_at: point.expires_at,
            created_at: point.created_at,
            reason: point.reason
        }));
    }

    /**
     * Statistiques globales de fidélité (en-tête du tableau de bord backoffice).
     *
     * - points_distributed : total des points JAMAIS distribués (lifetime_points,
     *   jamais décrémenté → fiable même après expiration ou rachat).
     * - points_available  : points encore EN CIRCULATION (somme des total_points) ;
     *   c'est l'engagement financier de l'entreprise envers ses clients.
     * - points_redeemed   : points effectivement UTILISÉS sur des commandes (REDEEMED).
     * - eligible_customers: clients atteignant le seuil minimum → peuvent utiliser
     *   leurs points dès maintenant.
     *
     * La valeur en XOF de chaque agrégat est dérivée de config.point_value_in_xof.
     * Les clients supprimés (entity_status = DELETED) sont exclus.
     */
    async getLoyaltyStats() {
        const config = await this.getConfig();

        const [customerAgg, eligibleCustomers, customersWithPoints, redeemedAgg] =
            await Promise.all([
                // Points distribués (lifetime) + en circulation (total) — clients actifs.
                this.prisma.customer.aggregate({
                    where: { entity_status: { not: EntityStatus.DELETED } },
                    _sum: { total_points: true, lifetime_points: true },
                }),
                // Clients qui peuvent utiliser leurs points (seuil minimum atteint).
                this.prisma.customer.count({
                    where: {
                        entity_status: { not: EntityStatus.DELETED },
                        total_points: { gte: config.minimum_redemption_points },
                    },
                }),
                // Clients ayant au moins 1 point en circulation.
                this.prisma.customer.count({
                    where: {
                        entity_status: { not: EntityStatus.DELETED },
                        total_points: { gt: 0 },
                    },
                }),
                // Points effectivement rachetés (utilisés sur des commandes).
                this.prisma.loyaltyPoint.aggregate({
                    where: { type: LoyaltyPointType.REDEEMED },
                    _sum: { points: true },
                }),
            ]);

        const pointValue = config.point_value_in_xof;
        const pointsDistributed = customerAgg._sum.lifetime_points ?? 0;
        const pointsAvailable = customerAgg._sum.total_points ?? 0;
        const pointsRedeemed = redeemedAgg._sum.points ?? 0;

        return {
            points_distributed: pointsDistributed,
            points_distributed_xof: pointsDistributed * pointValue,
            points_available: pointsAvailable,
            points_available_xof: pointsAvailable * pointValue,
            points_redeemed: pointsRedeemed,
            points_redeemed_xof: pointsRedeemed * pointValue,
            eligible_customers: eligibleCustomers,
            customers_with_points: customersWithPoints,
            minimum_redemption_points: config.minimum_redemption_points,
            point_value_in_xof: pointValue,
        };
    }
}