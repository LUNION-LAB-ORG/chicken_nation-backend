import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { ResponseMessageDto } from './response-message.dto';

export class ResponseConversationsDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  unreadNumber: number;

  @ApiProperty()
  customerId: string;

  /**
   * Intitulé de la conversation. Pour un GROUPE interne, c'est son NOM, et
   * c'est ce que l'écran doit afficher : sans lui, la liste retombe sur la
   * concaténation des noms des participants, illisible au-delà de deux.
   * Il était stocké en base mais n'était renvoyé nulle part.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  subject?: string | null;

  /**
   * Conversation de GROUPE : interne (aucun client) et plus de deux
   * participants. Calculé par le serveur pour que chaque écran n'ait pas à
   * redécouvrir la règle, et qu'elle reste la même partout.
   */
  @ApiProperty()
  isGroup: boolean;

  @ApiProperty()
  /** Date du dernier message : c'est sur elle que l'application trie. */
  createdAt: Date;

  /** Même valeur, sous un nom honnête, pour les futures versions. */
  lastMessageAt?: Date;

  /** Dernière activité de la conversation, côté serveur. */
  updatedAt?: Date;

  @ApiProperty({ type: [Object] })
  messages: Omit<ResponseMessageDto, 'conversationId' | 'conversation'>[];

  @ApiProperty({ type: [Object] })
  restaurant?: {
    id: string;
    name: string;
    image:string
  } | null;

  @ApiProperty({ required: false })
  @IsOptional()
  customer?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    image: string;
  } | null;

  @ApiProperty({ type: [Object] })
  users: {
    id: string;
    fullName: string;
    image: string | null;
  }[];
}
