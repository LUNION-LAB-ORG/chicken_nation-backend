import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, MaxLength } from 'class-validator';

export class CancelCourseDto {
  @ApiProperty({ required: false, description: 'Raison de l\'annulation' })
  @IsOptional()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  reason?: string;
}
