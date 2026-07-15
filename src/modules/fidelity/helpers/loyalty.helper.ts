import { LoyaltyLevel } from '@prisma/client';

export class LoyaltyHelper {
  static getLevelBenefits(level: LoyaltyLevel): string[] {
    switch (level) {
      case LoyaltyLevel.STANDARD:
        return [
          'Accumulation de points sur chaque commande',
          'Accès aux promotions publiques',
          'Programme de parrainage'
        ];
      case LoyaltyLevel.VIP:
        return [
          'Tous les avantages Standard',
          'Accès aux promotions VIP',
          '10% de points bonus sur les commandes',
          'Support client prioritaire'
        ];
      case LoyaltyLevel.VVIP:
        return [
          'Tous les avantages VIP',
          'Accès aux promotions VVIP exclusives',
          '20% de points bonus sur les commandes',
          'Livraison gratuite',
          'Invitations aux événements spéciaux'
        ];
      default:
        return [];
    }
  }

  static getLevelColor(level: LoyaltyLevel): string {
    switch (level) {
      case LoyaltyLevel.STANDARD:
        return '#6B7280'; // Gris
      case LoyaltyLevel.VIP:
        return '#8B5CF6'; // Violet
      case LoyaltyLevel.VVIP:
        return '#F59E0B'; // Doré
      default:
        return '#6B7280';
    }
  }

  static formatPointsDisplay(points: number): string {
    if (points >= 1000) {
      return `${(points / 1000).toFixed(1)}k points`;
    }
    return `${points} points`;
  }
}