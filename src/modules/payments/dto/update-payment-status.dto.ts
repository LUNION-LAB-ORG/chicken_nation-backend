import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PaymentStatus } from '../entities/payment.entity';

export class UpdatePaymentStatusDto {
  @IsEnum(PaymentStatus)
  @IsNotEmpty()
  status: PaymentStatus;

  @IsString()
  @IsOptional()
  transactionReference?: string;
}