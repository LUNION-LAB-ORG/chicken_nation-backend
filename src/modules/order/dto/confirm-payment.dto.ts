import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';

/**
 * Corps de POST /orders/:id/confirm-payment (confirmation manuelle admin).
 * Seul l'id de transaction KKiaPay est requis : il est RE-VÉRIFIÉ côté serveur
 * (verifyTransaction) avant toute confirmation. Aucun « force » possible.
 */
export class ConfirmPaymentDto {
  @ApiProperty({ description: 'Id de la transaction KKiaPay à vérifier' })
  @IsString()
  @Transform(({ value }) => String(value))
  transactionId: string;
}
