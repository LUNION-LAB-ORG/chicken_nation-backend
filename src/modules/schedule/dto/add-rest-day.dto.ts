import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';

export class AddRestDayDto {
  @ApiProperty({
    description: "Jour de repos demandé (ISO date, doit être >= aujourd'hui)",
    example: '2026-05-15',
  })
  @Type(() => Date)
  @IsDate()
  date!: Date;

  @ApiPropertyOptional({
    description: 'Raison libre (max 500 caractères)',
    example: 'Mariage cousin',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
