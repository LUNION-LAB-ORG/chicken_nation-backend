import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

  /**
   * GROUPE INTERNE : les collègues à réunir, en plus du créateur.
   *
   * Deux identifiants ou plus créent un groupe ; un seul revient exactement à
   * `receiver_user_id`, conservé pour ne casser aucun appelant existant. Le
   * plafond n'est pas décoratif : chaque participant reçoit une notification
   * par message, et une conversation à cinquante n'est plus une conversation.
   */
  @ApiPropertyOptional({
    description: 'Participants d\'un groupe interne (hors créateur)',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsUUID('4', { each: true })
  @IsOptional()
  participant_user_ids?: string[];
}
