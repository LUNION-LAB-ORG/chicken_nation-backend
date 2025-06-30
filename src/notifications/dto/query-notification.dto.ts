import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsBoolean, IsUUID, IsOptional } from 'class-validator';
import { NotificationTarget, NotificationType } from '@prisma/client';
import { Type } from 'class-transformer';

export class QueryNotificationDto {
  @ApiPropertyOptional({
    description: 'Page actuelle',
    example: 1
  })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Nombre d\'éléments par page',
    example: 10
  })
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Identifiant de l\'utilisateur',
    example: '550e8400-e29b-41d4-a716-446655440000'
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    enum: NotificationTarget,
    description: 'Cible de la notification (utilisateur ou client)',
    example: NotificationTarget.CUSTOMER
  })
  @IsOptional()
  @IsEnum(NotificationTarget)
  target?: NotificationTarget;

  @ApiPropertyOptional({
    enum: NotificationType,
    description: 'Type de notification',
    example: NotificationType.ORDER
  })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({
    description: 'Statut de lecture de la notification',
    example: false
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isRead?: boolean;
}