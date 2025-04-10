import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsArray, IsUUID, IsObject, IsBoolean } from 'class-validator';
import { NotificationType } from 'src/notifications/enums/notification.enum';

export class AdminNotificationBaseDto {
  @ApiProperty({
    description: 'Icône de la notification',
    example: 'notification',
  })
  @IsString()
  icon: string;

  @ApiProperty({
    description: 'Couleur de fond de l\'icône de la notification',
    example: '#4CAF50',
  })
  @IsString()
  iconBgColor: string;

  @ApiProperty({
    description: 'Titre de la notification',
    example: 'Nouvelle promotion disponible',
  })
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Message de la notification',
    example: 'Profitez de 20% de réduction sur votre prochaine commande',
  })
  @IsString()
  message: string;

  @ApiProperty({
    description: 'Type de notification',
    enum: NotificationType,
    example: NotificationType.PROMO,
  })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({
    description: 'Bannière de notification',
    example: 'promo-banner',
    required: false,
  })
  @IsOptional()
  @IsString()
  notifBanner?: string;

  @ApiProperty({
    description: 'Titre de notification pour l\'affichage',
    example: 'Promotion Spéciale',
    required: false,
  })
  @IsOptional()
  @IsString()
  notifTitle?: string;

  @ApiProperty({
    description: 'Affichage du chevron de la notification',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  showChevron?: boolean;

  @ApiProperty({
    description: 'Données supplémentaires liées à la notification',
    example: { promoCode: 'SUMMER20', expiryDate: '2023-08-31' },
    required: false,
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}

export class AdminNotificationToUsersDto extends AdminNotificationBaseDto {
  @ApiProperty({
    description: 'Liste des IDs des utilisateurs qui recevront la notification',
    example: ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001'],
    type: [String],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  userIds: string[];
}

export class AdminBroadcastNotificationDto extends AdminNotificationBaseDto {
  @ApiProperty({
    description: 'Envoyer la notification à tous les utilisateurs',
    example: true,
  })
  @IsBoolean()
  broadcast: boolean;

  @ApiProperty({
    description: 'Envoyer également par email',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;

  @ApiProperty({
    description: 'Envoyer également par notification push',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  sendPush?: boolean;
}
