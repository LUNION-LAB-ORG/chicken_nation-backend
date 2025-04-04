import { IsNotEmpty, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MobileMoneyTransactionStatus } from '../entities/mobile-money-transaction.entity';

export class MobileMoneyStatusUpdateDto {
  @ApiProperty({
    description: 'Statut de la transaction',
    enum: MobileMoneyTransactionStatus,
    example: MobileMoneyTransactionStatus.COMPLETED,
  })
  @IsNotEmpty()
  @IsEnum(MobileMoneyTransactionStatus)
  status: MobileMoneyTransactionStatus;

  @ApiPropertyOptional({
    description: 'Réponse du fournisseur de paiement',
    example: { reference: 'provider-ref-123', status: 'success' },
  })
  @IsOptional()
  provider_response?: Record<string, any>;
}
