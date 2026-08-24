import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityStatus, Prisma, RewardType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { platOffrable } from 'src/modules/menu/utils/plat-offrable.util';
import { CreateScratchLotDto } from '../dto/create-scratch-lot.dto';
import { UpdateScratchLotDto } from '../dto/update-scratch-lot.dto';

/**
 * CRUD des lots « Gratte & Gagne » (back office). Valide et SNAPSHOTTE le payload
 * selon le type (comme les campagnes Reward) : le moteur (ScratchEngineService)
 * recopie ensuite ce payload tel quel dans le Reward produit, sans relecture DB.
 */
@Injectable()
export class ScratchLotService {
    constructor(private readonly prisma: PrismaService) { }

    async list() {
        return this.prisma.scratchLot.findMany({ orderBy: [{ is_floor: 'desc' }, { created_at: 'desc' }] });
    }

    async get(id: string) {
        const lot = await this.prisma.scratchLot.findUnique({ where: { id } });
        if (!lot) throw new NotFoundException('Lot introuvable');
        return lot;
    }

    async create(dto: CreateScratchLotDto, adminId: string) {
        // Le lot plancher est unique et géré par le seed : on interdit d'en créer un 2e.
        if (dto.is_floor) {
            const existingFloor = await this.prisma.scratchLot.findFirst({ where: { is_floor: true } });
            if (existingFloor) {
                throw new BadRequestException('Un lot plancher existe déjà (un seul autorisé).');
            }
        }
        const payload = await this.buildPayload(dto.reward_type, dto.payload ?? {}, adminId, !!dto.is_floor);

        return this.prisma.scratchLot.create({
            data: {
                label: dto.label,
                reward_type: dto.reward_type,
                payload: payload as Prisma.InputJsonValue,
                weight: dto.weight ?? 1,
                unit_cost: dto.unit_cost ?? 0,
                min_cart: dto.min_cart ?? 0,
                frequency_cap: dto.frequency_cap ?? null,
                stock: dto.stock ?? null,
                level_min: dto.level_min ?? null,
                min_paid_orders: dto.min_paid_orders ?? 0,
                min_revenue: dto.min_revenue ?? 0,
                is_floor: dto.is_floor ?? false,
                active: dto.active ?? true,
            },
        });
    }

    async update(id: string, dto: UpdateScratchLotDto, adminId: string) {
        const lot = await this.get(id);

        // Recalcule/valide le payload si le type OU le payload changent.
        let payload: Prisma.InputJsonValue | undefined;
        if (dto.payload !== undefined || dto.reward_type !== undefined) {
            const type = dto.reward_type ?? lot.reward_type;
            const raw = dto.payload ?? (lot.payload as Record<string, any>);
            payload = (await this.buildPayload(type, raw, adminId, dto.is_floor ?? lot.is_floor)) as Prisma.InputJsonValue;
        }

        return this.prisma.scratchLot.update({
            where: { id },
            data: {
                ...(dto.label !== undefined && { label: dto.label }),
                ...(dto.reward_type !== undefined && { reward_type: dto.reward_type }),
                ...(payload !== undefined && { payload }),
                ...(dto.weight !== undefined && { weight: dto.weight }),
                ...(dto.unit_cost !== undefined && { unit_cost: dto.unit_cost }),
                ...(dto.min_cart !== undefined && { min_cart: dto.min_cart }),
                ...(dto.frequency_cap !== undefined && { frequency_cap: dto.frequency_cap }),
                ...(dto.stock !== undefined && { stock: dto.stock }),
                ...(dto.level_min !== undefined && { level_min: dto.level_min }),
                ...(dto.min_paid_orders !== undefined && { min_paid_orders: dto.min_paid_orders }),
                ...(dto.min_revenue !== undefined && { min_revenue: dto.min_revenue }),
                ...(dto.active !== undefined && { active: dto.active }),
            },
        });
    }

    async remove(id: string) {
        const lot = await this.get(id);
        if (lot.is_floor) {
            throw new BadRequestException('Le lot plancher ne peut pas être supprimé (continuité du grattage).');
        }
        // Soft-disable si des tirages y sont rattachés (préserve l'audit ScratchDraw) ;
        // suppression physique seulement si jamais tiré.
        const used = await this.prisma.scratchDraw.count({ where: { scratch_lot_id: id } });
        if (used > 0) {
            return this.prisma.scratchLot.update({ where: { id }, data: { active: false } });
        }
        return this.prisma.scratchLot.delete({ where: { id } });
    }

    /**
     * Valide + enrichit le payload selon le type (aligné sur RewardCampaignService.buildPayload).
     *   POINTS     → { points } (le plancher ignore ce champ ; gros lot POINTS = bonus)
     *   GIFT       → { dish_id, quantity? } snapshot nom/prix/image
     *   VOUCHER    → { amount, created_by }  (created_by = admin, requis au grattage)
     *   PROMO_CODE → { code, ... } snapshot remise
     */
    private async buildPayload(
        type: RewardType,
        payload: Record<string, any>,
        adminId: string,
        isFloor: boolean,
    ): Promise<Record<string, any>> {
        if (type === RewardType.POINTS) {
            // Le plancher (POINTS, is_floor) est la SEULE source POINTS : il révèle
            // TOUJOURS les earnedPoints réels de la commande (payload ignoré par le
            // moteur). Un gros lot POINTS bonus n'est PAS supporté : le grattage ne
            // crédite jamais de points au-delà du plancher → le bonus serait perdu.
            if (isFloor) return { points: 0 };
            throw new BadRequestException(
                "Un lot POINTS non-plancher n'est pas supporté : le plancher gère déjà les points.",
            );
        }

        if (type === RewardType.GIFT) {
            const quantity = Number(payload.quantity);
            const qtyPart = Number.isFinite(quantity) && quantity > 0 ? { quantity } : {};

            // Cadeau = un PLAT ou un SUPPLÉMENT précis, offert au panier à 0 fr
            // (aligné sur RewardCampaignService.buildPayload). Supplément prioritaire
            // s'il est fourni.
            if (payload.supplement_id) {
                const supp = await this.prisma.supplement.findUnique({
                    where: { id: payload.supplement_id },
                });
                if (!supp || supp.available === false) {
                    throw new BadRequestException('Supplément introuvable ou indisponible.');
                }
                return {
                    item_type: 'SUPPLEMENT',
                    supplement_id: supp.id,
                    label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : supp.name,
                    name: supp.name,
                    price: supp.price,
                    ...qtyPart,
                    ...(supp.image ? { image: supp.image } : {}),
                };
            }

            const dishId = payload.dish_id;
            if (!dishId || typeof dishId !== 'string') {
                throw new BadRequestException('Sélectionnez le plat ou le supplément offert.');
            }
            const dish = await this.prisma.dish.findUnique({ where: { id: dishId } });
            if (!dish || dish.entity_status === EntityStatus.DELETED) {
                throw new BadRequestException('Plat introuvable ou indisponible.');
            }
            /**
             * MENUS COMPOSABLES : un plat composable s'offre désormais.
             *
             * Le serveur applique sa composition PAR DÉFAUT au moment de la
             * commande, et ne la facture pas puisque le client n'a rien ajouté.
             * Ne reste refusé que le plat dont un groupe obligatoire n'offre
             * aucun choix disponible, qui serait impossible à composer.
             */
            const offrable = await platOffrable(this.prisma, dish.id);
            if (!offrable.ok) {
                throw new BadRequestException(
                    `${dish.name} ne peut pas être offert : ${offrable.raison}.`,
                );
            }
            return {
                item_type: 'DISH',
                dish_id: dish.id,
                label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : dish.name,
                name: dish.name,
                price: dish.price,
                ...qtyPart,
                ...(dish.image ? { image: dish.image } : {}),
            };
        }

        if (type === RewardType.VOUCHER) {
            const amount = Number(payload.amount);
            if (!(amount > 0)) {
                throw new BadRequestException('Un montant strictement positif est requis pour un bon.');
            }
            // created_by requis à la création du vrai bon AU GRATTAGE (RewardService).
            return { amount, created_by: adminId };
        }

        if (type === RewardType.PROMO_CODE) {
            if (!payload.code || typeof payload.code !== 'string') {
                throw new BadRequestException('Un code promo est requis.');
            }
            const promo = await this.prisma.promoCode.findUnique({ where: { code: payload.code } });
            if (!promo || !promo.is_active || promo.entity_status === EntityStatus.DELETED) {
                throw new BadRequestException('Code promo introuvable ou inactif.');
            }
            return {
                code: promo.code,
                discount_type: promo.discount_type,
                discount_value: promo.discount_value,
                ...(promo.description ? { description: promo.description } : {}),
            };
        }

        throw new BadRequestException('Type de lot non supporté.');
    }

    /**
     * HISTORIQUE DES TIRAGES (05/08) : qui a gagné quoi, sur quelle commande,
     * et ce que le gain est devenu. Par défaut on ne liste que les GROS LOTS
     * (le plancher = simple révélation des points, sans intérêt de pilotage) ;
     * `include_floor=true` pour tout voir. Le statut du gain est dérivé du
     * Reward : à gratter / gratté / utilisé / révoqué / expiré. Pour un cadeau
     * UTILISÉ, Reward.order_id pointe la commande de CONSOMMATION (le claim la
     * réécrit) — la commande d'ORIGINE reste celle du tirage.
     */
    async listDraws(opts: {
        page?: number;
        limit?: number;
        lotId?: string;
        startDate?: string;
        endDate?: string;
        includeFloor?: boolean;
    } = {}) {
        const page = Math.max(1, opts.page ?? 1);
        const limit = Math.min(100, Math.max(1, opts.limit ?? 20));

        const where: Prisma.ScratchDrawWhereInput = {
            ...(opts.includeFloor ? {} : { scratch_lot_id: { not: null } }),
            ...(opts.lotId ? { scratch_lot_id: opts.lotId } : {}),
            ...(opts.startDate || opts.endDate
                ? {
                    created_at: {
                        ...(opts.startDate ? { gte: new Date(opts.startDate) } : {}),
                        ...(opts.endDate
                            ? { lte: new Date(new Date(opts.endDate).setHours(23, 59, 59, 999)) }
                            : {}),
                    },
                }
                : {}),
        };

        const [draws, total] = await Promise.all([
            this.prisma.scratchDraw.findMany({
                where,
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    lot: { select: { id: true, label: true, reward_type: true, unit_cost: true } },
                    customer: {
                        select: { id: true, first_name: true, last_name: true, phone: true, image: true },
                    },
                    order: { select: { id: true, reference: true } },
                    reward: {
                        select: {
                            id: true,
                            status: true,
                            scratched_at: true,
                            consumed_at: true,
                            expires_at: true,
                            payload: true,
                            order: { select: { id: true, reference: true } },
                        },
                    },
                },
            }),
            this.prisma.scratchDraw.count({ where }),
        ]);

        const now = Date.now();
        const data = draws.map((d) => {
            const r = d.reward;
            let statut: string;
            if (!r) statut = 'SANS_GAIN';
            else if (r.status === 'REVOKED') statut = 'REVOQUE';
            else if (r.status === 'CONSUMED') statut = 'UTILISE';
            else if (r.status === 'SCRATCHED') statut = 'GRATTE';
            else if (r.expires_at && r.expires_at.getTime() < now) statut = 'EXPIRE';
            else statut = 'A_GRATTER';

            // Commande d'utilisation : celle du Reward quand elle DIFFÈRE de la
            // commande d'origine (le claim de consommation la réécrit).
            const usageOrder =
                r?.order && r.order.id !== d.order_id ? r.order : null;

            return {
                id: d.id,
                date_tirage: d.created_at,
                lot: d.lot,
                cout: d.cost,
                client: d.customer && {
                    id: d.customer.id,
                    name: [d.customer.first_name, d.customer.last_name].filter(Boolean).join(' '),
                    phone: d.customer.phone,
                    image: d.customer.image,
                },
                commande_origine: d.order,
                statut,
                gratte_le: r?.scratched_at ?? null,
                utilise_le: r?.consumed_at ?? null,
                commande_utilisation: usageOrder,
                expire_le: r?.expires_at ?? null,
                stock_restaure: d.restored_at != null,
            };
        });

        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
}
