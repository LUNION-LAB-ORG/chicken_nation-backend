import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Réglages du scan de commande (capture Glovo/Yango), stockés dans `settings`
 * sous le préfixe `prospect.*`. La remise et les messages sont dans le CRM.
 */
export class UpdateProspectSettingsDto {
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
