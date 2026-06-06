import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Réglages du module Base de Données (cahier §4.8 + §4.9).
 * Stockés dans la table `settings` sous le préfixe `prospect.*`.
 */
export class UpdateProspectSettingsDto {
  @ApiPropertyOptional({ description: 'Validité du coupon (jours)', example: 7 })
  @IsOptional()
  @IsInt()
  @Min(1)
  coupon_validity_days?: number;

  @ApiPropertyOptional({ enum: ['PERCENTAGE', 'FIXED_AMOUNT'] })
  @IsOptional()
  @IsIn(['PERCENTAGE', 'FIXED_AMOUNT'])
  coupon_discount_type?: string;

  @ApiPropertyOptional({ description: 'Valeur (% ou FCFA)', example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  coupon_discount_value?: number;

  @ApiPropertyOptional({ description: "Lien de l'app inséré dans les messages" })
  @IsOptional()
  @IsString()
  app_link?: string;

  @ApiPropertyOptional({ description: 'Modèle message Découverte' })
  @IsOptional()
  @IsString()
  msg_decouverte?: string;

  @ApiPropertyOptional({ description: 'Modèle message Relance 1' })
  @IsOptional()
  @IsString()
  msg_relance_1?: string;

  @ApiPropertyOptional({ description: 'Modèle message Relance 2 / Fidélité' })
  @IsOptional()
  @IsString()
  msg_relance_2?: string;

  // --- Scan de commande (OCR / IA) ---
  @ApiPropertyOptional({ enum: ['TESSERACT', 'GEMINI', 'OPENAI', 'ANTHROPIC'] })
  @IsOptional()
  @IsIn(['TESSERACT', 'GEMINI', 'OPENAI', 'ANTHROPIC'])
  scan_engine?: string;

  @ApiPropertyOptional({ description: "Clé API du moteur d'IA (vide pour Tesseract)" })
  @IsOptional()
  @IsString()
  scan_api_key?: string;

  @ApiPropertyOptional({ description: 'Modèle IA (optionnel, ex. gpt-4o-mini)' })
  @IsOptional()
  @IsString()
  scan_model?: string;
}
