import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

export class ResponseMessageDto {
  @ApiProperty()
  id: string;

  /**
   * Réactions déjà AGRÉGÉES : un emoji, son compte, et « l'ai-je posé ».
   *
   * Calculé par le serveur plutôt que par chaque écran : les trois applications
   * qui lisent ces messages en tireraient sinon trois résultats différents. La
   * liste n'est jamais nominative, savoir qui a mis un pouce n'intéresse
   * personne et exposerait des identités sans raison. Champ OPTIONNEL : les
   * consommateurs qui l'ignorent ne voient aucune différence.
   */
  @ApiProperty({ required: false, type: [Object] })
  reactions?: { emoji: string; count: number; mine: boolean }[];

  /** Message retiré par son auteur ou par un administrateur. */
  @ApiProperty({ required: false })
  deleted?: boolean;

  @ApiProperty({ required: false })
  deletedAt?: Date | null;

  @ApiProperty({ type: [Object] })
  conversation: {
    id: string;
    restaurantId: string;
    customerId?: string | null;
  };

  @ApiProperty()
  body: string;

  @ApiProperty()
  isRead: boolean;

  /**
   * Heure à laquelle l'autre partie a ouvert la conversation.
   *
   * ⚠️ Sémantique honnête : « la conversation a été ouverte », et non « ce
   * message précis a été lu ». C'est le seul signal dont dispose le serveur.
   */
  readAt?: Date | string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ required: false })
  @IsOptional()
  authorUser?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  } | null;

  @ApiProperty({ required: false })
  @IsOptional()
  authorCustomer?: {
    id: string;
    name: string;
    first_name?: string | null;
    last_name?: string | null;
    image?: string | null;
  } | null;

  @ApiProperty({ required: false })
  @IsOptional()
  meta?: {
    imageUrl?: string | null;
    orderId?: string | null;
  };
}