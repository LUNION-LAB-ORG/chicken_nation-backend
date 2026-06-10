import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

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

  @ApiPropertyOptional({ description: 'Identifiant de la commande associée au message' })
  @IsUUID(undefined, { message: 'L\'identifiant de la commande doit être un UUID valide' })
  @IsOptional()
  orderId?: string;
}
