import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMessageDto {
  // Optionnel pour permettre les messages "image seule" (le service exige
  // body OU image — voir message.service.createMessage).
  @ApiPropertyOptional({ description: 'Contenu du message (optionnel si une image est jointe)' })
  @IsString({ message: 'Le contenu du message doit être une chaîne de caractères' })
  @IsOptional()
  body?: string;

  @ApiPropertyOptional({ description: 'URL de l\'image associée au message' })
  @IsString({ message: 'L\'URL de l\'image doit être une chaîne de caractères' })
  @IsOptional()
  imageUrl?: string;

  /**
   * ⚠️ Le tunnel de validation fonctionne en LISTE BLANCHE : tout champ non
   * déclaré ici est supprimé EN SILENCE avant d'atteindre le service. Une note
   * vocale envoyée sans ces déclarations disparaîtrait sans le moindre message
   * d'erreur.
   */
  @ApiPropertyOptional({ description: 'URL de la note vocale associée au message' })
  @IsString({ message: 'L\'URL de la note vocale doit être une chaîne de caractères' })
  @IsOptional()
  audioUrl?: string;

  @ApiPropertyOptional({ description: 'Durée de la note vocale en millisecondes' })
  @Type(() => Number)
  @IsInt({ message: 'La durée de la note vocale doit être un entier' })
  @Min(0, { message: 'La durée de la note vocale ne peut pas être négative' })
  // Une note vocale de plus d'une heure n'est pas une note vocale.
  @Max(3_600_000, { message: 'La durée de la note vocale est hors limites' })
  @IsOptional()
  audioDurationMs?: number;

  @ApiPropertyOptional({ description: 'Identifiant de la commande associée au message' })
  @IsUUID(undefined, { message: 'L\'identifiant de la commande doit être un UUID valide' })
  @IsOptional()
  orderId?: string;
}
