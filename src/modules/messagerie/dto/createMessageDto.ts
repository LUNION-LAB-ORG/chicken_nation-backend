import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MAX_MENTIONS, normaliserListeIds } from '../utils/mentions';

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

  /**
   * Message auquel on RÉPOND. Il doit appartenir à la même conversation et ne
   * pas être supprimé (vérifié par le service). Chaîne vide = pas de réponse :
   * un formulaire multipart envoie volontiers le champ vide.
   */
  @ApiPropertyOptional({ description: 'Identifiant du message cité (réponse à un message précis)' })
  @Transform(({ value }) => (value === '' || value === null ? undefined : value))
  @IsOptional()
  @IsUUID(undefined, { message: "L'identifiant du message cité doit être un UUID valide" })
  replyToId?: string;

  /**
   * Collègues MENTIONNÉS (« @Prénom Nom » dans le texte). Réservé au personnel,
   * dans une conversation interne. Les identifiants non retenus (non-membre,
   * sans accès à la messagerie, nom absent du texte) sont ignorés sans échec.
   * En multipart, un seul identifiant arrive en chaîne : on le remet en liste.
   */
  @ApiPropertyOptional({
    description: 'Identifiants des collègues mentionnés',
    type: [String],
  })
  @Transform(({ value }) => normaliserListeIds(value))
  @IsOptional()
  @IsArray({ message: 'Les mentions doivent être une liste d\'identifiants' })
  @ArrayMaxSize(MAX_MENTIONS, {
    message: `Pas plus de ${MAX_MENTIONS} personnes mentionnées par message`,
  })
  @IsUUID(undefined, {
    each: true,
    message: 'Chaque personne mentionnée doit avoir un identifiant UUID valide',
  })
  mentionUserIds?: string[];
}
