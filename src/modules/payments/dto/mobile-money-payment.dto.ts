import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsNumber, IsString, IsNotEmpty, Min } from 'class-validator';

export class MobileMoneyPaymentDto {
  @ApiProperty({ description: 'ID de la commande' })
  @IsUUID()
  @IsNotEmpty()
  order_id: string;

  @ApiProperty({ description: 'Montant du paiement', minimum: 0 })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ description: 'Numéro de téléphone pour le paiement Mobile Money' })
  @IsString()
  @IsNotEmpty()
  phone_number: string;

  @ApiProperty({ description: 'Opérateur Mobile Money (ex: Orange, MTN, Moov)' })
  @IsString()
  @IsNotEmpty()
  operator: string;
}
