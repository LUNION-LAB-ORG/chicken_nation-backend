import { IsObject, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateNotificationSettingsDto {
  @ApiProperty({ description: 'Préférences pour les notifications par email' })
  @IsObject()
  @IsOptional()
  emailPreferences?: Record<string, boolean>;

  @ApiProperty({ description: 'Préférences pour les notifications push' })
  @IsObject()
  @IsOptional()
  pushPreferences?: Record<string, boolean>;

  @ApiProperty({ description: 'Préférences pour les notifications SMS' })
  @IsObject()
  @IsOptional()
  smsPreferences?: Record<string, boolean>;
}
