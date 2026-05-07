import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefuseAssignmentDto {
  @ApiPropertyOptional({
    description: 'Raison libre du refus (max 500 caractères)',
    example: 'Indisponible ce jour-là (rendez-vous médical)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
