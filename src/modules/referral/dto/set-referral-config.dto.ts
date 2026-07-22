import { ApiPropertyOptional } from '@nestjs/swagger';
import { RewardType } from '@prisma/client';
import { IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Config du parrainage (back office). `parrain` reste souplement typé (validé côté
 * service) : { type: RewardType, payload, expires_in_days? }. Inclut le volet
 * MONÉTAIRE (Phase 5) : prime, commission, fenêtre, plafond, panier mini, seuil.
 */
export class SetReferralConfigDto {
  @ApiPropertyOptional({ description: 'Montant du bon de bienvenue du filleul (FCFA)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  welcome_amount?: number;

  @ApiPropertyOptional({
    description:
      'Cadeau du parrain : { mode: FIXED|RANDOM, items: [{ type, payload, expires_in_days? }] } (legacy { type, payload } accepté)',
  })
  @IsOptional()
  @IsObject()
  parrain?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      "Cadeau du filleul (à l'inscription) : { mode: FIXED|RANDOM, items: [...] } (legacy { type, payload } accepté)",
  })
  @IsOptional()
  @IsObject()
  filleul?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Id User créateur des bons système (vide = 1er User)' })
  @IsOptional()
  @IsString()
  created_by?: string;

  @ApiPropertyOptional({ description: 'Prime fixe par filleul qualifié (FCFA)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  prime_amount?: number;

  @ApiPropertyOptional({ description: 'Commission sur le CA des commandes du filleul (%)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_pct?: number;

  @ApiPropertyOptional({ description: 'Durée de la fenêtre de commission (jours, défaut 90)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  commission_window_days?: number;

  @ApiPropertyOptional({ description: 'Plafond total (prime + commission) par filleul (FCFA)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  cap_per_referee?: number;

  @ApiPropertyOptional({ description: 'Panier minimum de la commande qualifiante pour la prime (FCFA)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  min_qualifying_basket?: number;

  @ApiPropertyOptional({ description: 'Seuil de solde à partir duquel les gains deviennent versables (FCFA)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  payout_threshold?: number;
}
