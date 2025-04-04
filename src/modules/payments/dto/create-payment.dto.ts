import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentMethod } from '../entities/payment.entity';

export class CreatePaymentDto {
  @IsUUID()
  @IsNotEmpty()
  order_id: string;

  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  method: PaymentMethod;

  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsString()
  @IsOptional()
  transaction_reference?: string;
}