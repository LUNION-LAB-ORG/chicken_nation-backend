import { IsString, IsNumber, IsOptional, IsDateString, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTableReservationDto {
  @ApiProperty({ description: 'ID du restaurant' })
  @IsString()
  restaurant_id: string;

  @ApiProperty({ description: 'Date de la ru00e9servation (format YYYY-MM-DD)' })
  @IsDateString()
  reservation_date: string;

  @ApiProperty({ description: 'Heure de la ru00e9servation (format HH:MM)' })
  @IsString()
  reservation_time: string;

  @ApiProperty({ description: 'Nombre de personnes' })
  @IsNumber()
  @Min(1)
  party_size: number;

  @ApiProperty({ description: 'Demandes spu00e9ciales', required: false })
  @IsString()
  @IsOptional()
  special_requests?: string;
}
