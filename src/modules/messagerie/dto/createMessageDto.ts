import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateMessageDto {
  @ApiPropertyOptional({ description: 'Contenu du message' })
  @IsString({ message: 'Le contenu du message doit être une chaîne de caractères' })
  @IsNotEmpty({ message: 'Le contenu du message ne peut pas être vide' })
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
