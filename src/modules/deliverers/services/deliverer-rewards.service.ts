import { Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

/**
 * Niveaux de récompense (gamification livreur).
 *
 * Doit rester aligné avec la structure UI dans
 * `chicken-nation-deli/app/recompenses.tsx` (NIVEAUX[]).
 *
 * `xpRequired` est le SEUIL TOTAL en XP à atteindre pour débloquer le niveau.
 */
export const REWARD_LEVELS = [
  { id: 'veteran',     name: 'LE VETERAN',     xpRequired: 7000,  bonusFcfa: 15000 },
  { id: 'ambassadeur', name: "L'AMBASSADEUR", xpRequired: 14000, bonusFcfa: 20000 },
  { id: 'elite',       name: "L'ELITE",       xpRequired: 21000, bonusFcfa: 25000 },
] as const;

/**
 * Pondération XP par événement.
 *
 * - DELIVERED  : +100 XP (livraison réussie)
 * - 5★ rating  : +50 XP bonus (le livreur a noté le client 5 — proxy de fluide)
 *   NB : on récompense le fait que LE LIVREUR ait noté (donc fait l'effort de
 *   donner du feedback), pas la note reçue elle-même.
 * - FAILED     : +20 XP (effort présent mais résultat partiel)
 */
const XP_PER_DELIVERED = 100;
const XP_PER_FAILED = 20;
const XP_BONUS_RATED = 50;

export interface IRewardLevelView {
  id: string;
  name: string;
  xpRequired: number;
  bonusFcfa: number;
  /** `true` si le livreur a atteint ce niveau. */
  unlocked: boolean;
  /** `true` si c'est le niveau actuellement en cours de progression. */
  current: boolean;
}

export interface IRewardsView {
  /** XP totaux cumulés depuis la création du compte. */
  totalXp: number;
  /** ID du niveau le plus élevé débloqué (ou `null` si aucun). */
  currentLevelId: string | null;
  /** Niveaux successifs avec leur statut (debloqué / en cours / verrouillé). */
  levels: IRewardLevelView[];
  /** Stats brutes pour debug/affichage secondaire. */
  stats: {
    deliveredCount: number;
    failedCount: number;
    ratedCount: number;
  };
}

@Injectable()
export class DelivererRewardsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calcule les XP + niveau du livreur à partir de ses livraisons réelles.
   *
   * Computé on-the-fly (pas de cache) — le coût est faible (3 count() Prisma
   * groupés sur Delivery) et garantit zéro drift entre les pondérations
   * actuelles et les XP affichés.
   */
  async getRewards(delivererId: string): Promise<IRewardsView> {
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { id: true },
    });
    if (!deliverer) throw new NotFoundException('Livreur non trouvé');

    // 3 stats agrégées via une seule requête groupée + 1 count séparé
    // (le rated_count est sur la sous-population DELIVERED).
    const [grouped, ratedCount] = await Promise.all([
      this.prisma.delivery.groupBy({
        by: ['statut'],
        where: {
          course: { deliverer_id: delivererId },
          statut: { in: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED] },
        },
        _count: { _all: true },
      }),
      this.prisma.delivery.count({
        where: {
          course: { deliverer_id: delivererId },
          customer_rating: { not: null },
        },
      }),
    ]);

    const deliveredCount = grouped.find((g) => g.statut === DeliveryStatut.DELIVERED)?._count._all ?? 0;
    const failedCount    = grouped.find((g) => g.statut === DeliveryStatut.FAILED)?._count._all    ?? 0;

    const totalXp =
      deliveredCount * XP_PER_DELIVERED +
      failedCount    * XP_PER_FAILED +
      ratedCount     * XP_BONUS_RATED;

    // Détermine le niveau courant (= le PLUS HAUT débloqué) et marque le
    // suivant comme "current" (en cours de progression).
    let currentLevelId: string | null = null;
    const levels: IRewardLevelView[] = REWARD_LEVELS.map((level, idx) => {
      const unlocked = totalXp >= level.xpRequired;
      if (unlocked) currentLevelId = level.id;
      // "current" = le niveau VERROUILLÉ qui suit immédiatement le dernier
      // débloqué. Si aucun débloqué : c'est le 1er. Si tous débloqués : aucun.
      const previousUnlocked = idx === 0 || totalXp >= REWARD_LEVELS[idx - 1].xpRequired;
      const current = !unlocked && previousUnlocked;
      return {
        id: level.id,
        name: level.name,
        xpRequired: level.xpRequired,
        bonusFcfa: level.bonusFcfa,
        unlocked,
        current,
      };
    });

    return {
      totalXp,
      currentLevelId,
      levels,
      stats: { deliveredCount, failedCount, ratedCount },
    };
  }
}
