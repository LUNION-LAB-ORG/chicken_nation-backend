import { DiscountType, TargetType } from '@prisma/client';

export class PromotionHelper {
  static validatePromotionData(data: any): string[] {
    const errors: string[] = [];

    // Validation des dates
    if (new Date(data.start_date) >= new Date(data.expiration_date)) {
      errors.push('La date de fin doit être postérieure à la date de début');
    }

    // Validation des valeurs de réduction
    if (data.discount_type === DiscountType.PERCENTAGE && (data.discount_value <= 0 || data.discount_value > 100)) {
      errors.push('Le pourcentage de réduction doit être entre 1 et 100');
    }

    if (data.discount_type === DiscountType.FIXED_AMOUNT && data.discount_value <= 0) {
      errors.push('Le montant de réduction doit être positif');
    }

    // Validation du ciblage
    if (data.target_type === TargetType.SPECIFIC_PRODUCTS && (!data.targeted_dish_ids || data.targeted_dish_ids.length === 0)) {
      errors.push('Vous devez sélectionner au moins un plat pour ce type de promotion');
    }

    if (data.target_type === TargetType.CATEGORIES && (!data.targeted_category_ids || data.targeted_category_ids.length === 0)) {
      errors.push('Vous devez sélectionner au moins une catégorie pour ce type de promotion');
    }

    // Validation des limites
    if (data.max_usage_per_user && data.max_usage_per_user < 1) {
      errors.push('La limite d\'utilisation par utilisateur doit être d\'au moins 1');
    }

    if (data.max_total_usage && data.max_total_usage < 1) {
      errors.push('La limite d\'utilisation totale doit être d\'au moins 1');
    }

    return errors;
  }

  static formatPromotionForDisplay(promotion: any) {
    let discountText = '';
    
    switch (promotion.discount_type) {
      case DiscountType.PERCENTAGE:
        discountText = `${promotion.discount_value}% de réduction`;
        break;
      case DiscountType.FIXED_AMOUNT:
        discountText = `${promotion.discount_value} XOF de réduction`;
        break;
      case DiscountType.BUY_X_GET_Y:
        discountText = 'Offre spéciale';
        break;
    }

    return {
      ...promotion,
      discount_text: discountText,
      is_expired: new Date(promotion.expiration_date) < new Date(),
      days_remaining: Math.ceil((new Date(promotion.expiration_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
    };
  }
}