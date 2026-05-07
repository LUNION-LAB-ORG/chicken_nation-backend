import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, MaxLength } from 'class-validator';

export class RefuseOfferDto {
  @ApiProperty({ required: false, description: 'Raison du refus (facultative)' })
  @IsOptional()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  reason?: string;
}
