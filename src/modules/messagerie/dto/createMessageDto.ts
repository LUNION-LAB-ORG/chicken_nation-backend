import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, isValidationOptions } from 'class-validator';

export class CreateMessageDto {
  @ApiPropertyOptional({ description: 'Contenu du message' })
  @IsString({ message: 'Le contenu du message doit être une chaîne de caractères' })
  body: string;

  @ApiPropertyOptional({ description: 'URL de l\'image associée au message' })
  @IsString({ message: 'L\'URL de l\'image doit être une chaîne de caractères' })
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Identifiant de la commande associée au message' })
  @IsUUID(undefined, { message: 'L\'identifiant de la commande doit être un UUID valide' })
  @IsOptional()
  orderId?: string;
}
