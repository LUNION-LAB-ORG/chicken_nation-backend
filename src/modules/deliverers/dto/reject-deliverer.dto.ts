import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, MaxLength, MinLength } from 'class-validator';

export class RejectDelivererDto {
  @ApiProperty({ example: 'Documents illisibles', description: 'Motif du refus' })
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  @Transform(({ value }) => String(value).trim())
  reason: string;
}

export class SuspendDelivererDto {
  @ApiProperty({ example: 'Non-respect des règles', required: false })
  @IsOptional()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  reason?: string;
}
