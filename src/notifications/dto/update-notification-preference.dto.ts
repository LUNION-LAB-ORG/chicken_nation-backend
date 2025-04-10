import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';

class NotificationChannelPreference {
  @ApiProperty({
    description: 'Activer/désactiver les notifications par email pour ce type',
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  email?: boolean;

  @ApiProperty({
    description: 'Activer/désactiver les notifications push pour ce type',
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  push?: boolean;

  @ApiProperty({
    description: 'Activer/désactiver les notifications in-app pour ce type',
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  inApp?: boolean;
}

export class UpdateNotificationPreferenceDto {
  @ApiProperty({
    description: 'Préférences pour les mises à jour de commandes',
    example: { email: true, push: true },
    required: false,
  })
  @IsOptional()
  @IsObject()
  orderUpdates?: Record<string, any>;

  @ApiProperty({
    description: 'Préférences pour les promotions',
    example: { email: true, push: false },
    required: false,
  })
  @IsOptional()
  @IsObject()
  promotions?: Record<string, any>;

  @ApiProperty({
    description: 'Préférences pour la newsletter',
    example: { email: true, push: false },
    required: false,
  })
  @IsOptional()
  @IsObject()
  newsletter?: Record<string, any>;

  @ApiProperty({
    description: 'Préférences pour les notifications push',
    example: { enabled: true, quietHours: { start: '22:00', end: '08:00' } },
    required: false,
  })
  @IsOptional()
  @IsObject()
  pushNotifications?: Record<string, any>;
}
