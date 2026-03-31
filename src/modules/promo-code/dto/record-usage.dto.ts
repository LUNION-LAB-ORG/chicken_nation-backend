import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class RecordUsageDto {
  @ApiPropertyOptional({ description: 'ID de la commande associée' })
  @IsOptional()
  @IsUUID()
  order_id?: string;

  @ApiProperty({ description: 'Montant de la réduction appliquée', example: 1500 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discount_amount: number;
}
