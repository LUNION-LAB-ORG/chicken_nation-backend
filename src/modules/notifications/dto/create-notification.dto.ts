import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, IsBoolean, IsOptional, IsUUID, IsObject } from 'class-validator';
import { NotificationTarget, NotificationType } from '@prisma/client';

export class CreateNotificationDto {
  @ApiProperty({
    description: 'Titre de la notification',
    example: 'Nouvelle commande reçue'
  })
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Message de la notification',
    example: 'Votre commande #CMD-001 a été confirmée et sera livrée dans 30 minutes.'
  })
  @IsString()
  message: string;

  @ApiProperty({
    enum: NotificationType,
    description: 'Type de notification',
    example: NotificationType.ORDER
  })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({
    description: 'Identifiant de l\'utilisateur destinataire',
    example: '550e8400-e29b-41d4-a716-446655440000'
  })
  @IsUUID()
  user_id: string;

  @ApiProperty({
    enum: NotificationTarget,
    description: 'Cible de la notification (utilisateur ou client)',
    example: NotificationTarget.CUSTOMER
  })
  @IsEnum(NotificationTarget)
  target: NotificationTarget;

  @ApiProperty({
    description: 'URL de l\'icône de la notification',
    example: 'https://example.com/icons/order.svg'
  })
  @IsString()
  icon: string;

  @ApiProperty({
    description: 'Couleur de fond de l\'icône (code hexadécimal)',
    example: '#4CAF50'
  })
  @IsString()
  icon_bg_color: string;

  @ApiPropertyOptional({
    description: 'Afficher ou non le chevron (flèche)',
    example: true,
    default: false
  })
  @IsBoolean()
  @IsOptional()
  show_chevron?: boolean;

  @ApiPropertyOptional({
    description: 'Données supplémentaires de la notification (JSON)',
    example: { order_id: 'CMD-001', amount: 15000 }
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}