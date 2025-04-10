import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, IsEnum, IsOptional, IsBoolean, IsDate, IsObject } from 'class-validator';
import { Type } from 'class-transformer';
import { NotificationType } from 'src/notifications/enums/notification.enum';

export class CreateNotificationDto {
  @ApiProperty({
    description: 'ID de l\'utilisateur qui recevra la notification',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  userId: string;

  @ApiProperty({
    description: 'Icône de la notification',
    example: 'icon',
  })
  @IsString()
  icon: string;

  @ApiProperty({
    description: 'Couleur de fond de l\'icône de la notification',
    example: 'bgColor',
  })
  @IsString()
  iconBgColor: string;

  @ApiProperty({
    description: 'Titre de la notification',
    example: 'Confirmation de paiement',
  })
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Date de la notification',
    example: '2022-01-01T00:00:00.000Z',
  })
  @Type(() => Date)
  @IsDate()
  date: Date;

  @ApiProperty({
    description: 'Heure de la notification',
    example: '12:00',
  })
  @IsString()
  time: string;

  @ApiProperty({
    description: 'Message de la notification',
    example: 'Votre paiement de 50€ a été confirmé',
  })
  @IsString()
  message: string;

  @ApiProperty({
    description: 'Type de notification',
    enum: NotificationType,
    example: NotificationType.PAYMENT,
  })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({
    description: 'État de lecture de la notification',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;

  @ApiProperty({
    description: 'Affichage du chevron de la notification',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  showChevron?: boolean;

  @ApiProperty({
    description: 'Bannière de notification',
    example: 'notifBanner',
  })
  @IsString()
  notifBanner: string;

  @ApiProperty({
    description: 'Titre de notification',
    example: 'notifTitle',
  })
  @IsString()
  notifTitle: string;

  @ApiProperty({
    description: 'Données supplémentaires liées à la notification',
    example: { orderId: '123', amount: 50 },
    required: false,
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}
