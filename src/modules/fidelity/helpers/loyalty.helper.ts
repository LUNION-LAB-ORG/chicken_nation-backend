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
      case LoyaltyLevel.PREMIUM:
        return [
          'Tous les avantages Standard',
          'Accès aux promotions Premium',
          '10% de points bonus sur les commandes',
          'Support client prioritaire'
        ];
      case LoyaltyLevel.GOLD:
        return [
          'Tous les avantages Premium',
          'Accès aux promotions Gold exclusives',
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
      case LoyaltyLevel.PREMIUM:
        return '#8B5CF6'; // Violet
      case LoyaltyLevel.GOLD:
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