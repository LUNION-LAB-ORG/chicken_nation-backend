import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateMessageDto {
  @ApiPropertyOptional({ description: 'Contenu du message' })
  @IsString({message:'Le contenu du message doit être une chaîne de caractères'})
  body: string;
}
