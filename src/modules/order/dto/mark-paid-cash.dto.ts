import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Payload envoyé par la caissière pour marquer une commande en espèce comme payée
 * (paiement reçu du livreur). Ferme la boucle pour les commandes OFFLINE non encore payées.
 */
export class MarkPaidCashDto {
  @ApiPropertyOptional({
    description: 'Montant reçu du livreur (FCFA). Si omis, on utilise Order.amount.',
    example: 12500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;
}
