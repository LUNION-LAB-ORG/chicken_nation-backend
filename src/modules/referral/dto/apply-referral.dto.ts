import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ApplyReferralDto {
  @ApiProperty({ description: 'Code de parrainage du parrain', example: 'CNABC23' })
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  code: string;
}
