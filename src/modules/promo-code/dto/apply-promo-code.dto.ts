import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class ApplyPromoCodeDto {
  @ApiProperty({ description: 'Code promotionnel', example: 'PROMO2026' })
  @IsNotEmpty()
  @IsString()
  code: string;

  @ApiProperty({ description: 'Montant de la commande', example: 15000 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  order_amount: number;
}
