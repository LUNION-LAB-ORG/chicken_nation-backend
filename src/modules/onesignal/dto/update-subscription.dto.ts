import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateSubscriptionDto {
  @ApiPropertyOptional({ description: 'Activer/désactiver la subscription' })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Nouveau token (push token, email, phone)' })
  @IsString()
  @IsOptional()
  token?: string;

  @ApiPropertyOptional({ description: 'Statut de notification (ex: 1 = subscribed, -2 = unsubscribed)' })
  @IsOptional()
  notification_types?: number;
}
