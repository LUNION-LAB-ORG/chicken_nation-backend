import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn } from 'class-validator';

/**
 * Édition admin d'un jour dans la matrice : bascule un (livreur, jour) en repos ou travail.
 */
export class SetDelivererDayDto {
  @ApiProperty({ example: '2026-06-09', description: 'Jour concerné (YYYY-MM-DD)' })
  @IsDateString()
  date: string;

  @ApiProperty({ enum: ['REST', 'WORK'], example: 'REST' })
  @IsIn(['REST', 'WORK'])
  mode: 'REST' | 'WORK';
}
