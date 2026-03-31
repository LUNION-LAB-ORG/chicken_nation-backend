import { ApiPropertyOptional } from '@nestjs/swagger';
import { RetentionCallbackStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateRetentionCallbackDto {
  @ApiPropertyOptional({ description: 'ID de la raison' })
  @IsUUID()
  @IsOptional()
  reason_id?: string;

  @ApiPropertyOptional({ description: 'Statut', enum: RetentionCallbackStatus })
  @IsEnum(RetentionCallbackStatus)
  @IsOptional()
  status?: RetentionCallbackStatus;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Date du prochain rappel' })
  @IsDateString()
  @IsOptional()
  next_callback_at?: string;
}
