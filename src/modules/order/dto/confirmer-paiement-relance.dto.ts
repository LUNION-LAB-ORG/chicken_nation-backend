import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { MESSAGE_TRANSACTION_ILLISIBLE, TRANSACTION_KKIAPAY } from '../helpers/confirmation-paiement.rules';

/**
 * Corps de `POST /orders/relances/:orderId/confirmer-paiement` (14/11) :
 * l'identifiant de la transaction KKiaPay que le client a payée. Jamais cru
 * sur parole : le serveur la revérifie auprès de KKiaPay avant de confirmer.
 */
export class ConfirmerPaiementRelanceDto {
  @ApiProperty({ maxLength: 64, description: 'Identifiant de la transaction KKiaPay' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(TRANSACTION_KKIAPAY, { message: MESSAGE_TRANSACTION_ILLISIBLE })
  transaction_id!: string;
}
