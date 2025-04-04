import { IsString, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRestaurantTableDto {
  @ApiProperty({ description: 'Capacitu00e9 de la table (nombre de personnes)' })
  @IsNumber()
  @Min(1)
  capacity: number;

  @ApiProperty({ description: 'Type de table (standard, VIP, terrasse, etc.)' })
  @IsString()
  type: string;

  @ApiProperty({ description: 'Nombre de tables de ce type disponibles' })
  @IsNumber()
  @Min(1)
  quantity: number;
}
