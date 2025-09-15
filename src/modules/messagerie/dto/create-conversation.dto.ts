import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID
} from 'class-validator';

export class CreateConversationDto {
  @ApiPropertyOptional({ description: 'L\'id de l\'utilisateur qui recoit le message' })
  @IsUUID()
  @IsOptional()
  receiver_user_id?: string;

  @ApiPropertyOptional({ description: 'Message initial' })
  @IsString()
  seed_message: string;

  @ApiPropertyOptional({ description: 'ID du restaurant' })
  @IsUUID()
  @IsOptional()
  restaurant_id?: string;

  @ApiPropertyOptional({ description: 'ID du restaurant' })
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiPropertyOptional({ description: 'ID du contact client' })
  @IsUUID()
  @IsOptional()
  customer_to_contact_id?:string
}
