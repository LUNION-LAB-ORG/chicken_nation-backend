import { PaiementMode, PaiementStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsString, IsNumber, IsBoolean, IsOptional, IsObject, IsEnum } from 'class-validator';

export class KkiapayResponse {
  @IsString()
  performed_at: string;

  @IsString()
  type: "DEBIT" | "CREDIT";

  @IsString()
  status: PaiementStatus;

  @IsString()
  source: PaiementMode;

  @IsString()
  source_common_name: string;

  @IsNumber()
  @Type(() => Number)
  amount: number;

  @IsNumber()
  @Type(() => Number)
  fees: number;

  @IsString()
  reason: string;

  @IsString()
  failureCode: string;

  @IsString()
  failureMessage: string;

  @IsString()
  state: string | null;

  @IsString()
  partnerId: string;

  @IsString()
  feeSupportedBy: string;

  @IsNumber()
  @Type(() => Number)
  income: number;

  @IsString()
  transactionId: string;

  @IsString()
  performedAt: string;

  @IsObject()
  client: {
    fullname: string;
    phone: string;
    email: string;
  }
}

export class KkiapayWebhookDto {
  @IsString()
  transactionId: string;

  @IsBoolean()
  @Type(() => Boolean)
  isPaymentSucces: boolean;

  @IsOptional()
  @IsString()
  account?: string | null;

  @IsString()
  label: string;

  @IsEnum(PaiementMode)
  method: PaiementMode;

  @IsNumber()
  @Type(() => Number)
  amount: number;

  @IsNumber()
  @Type(() => Number)
  fees: number;

  @IsString()
  performedAt: string;

  @IsString()
  stateData: string;

  @IsOptional()
  @IsString()
  partnerId?: string;

  @IsOptional()
  @IsString()
  failureCode?: string | null;

  @IsOptional()
  @IsString()
  failureMessage?: string | null;

  @IsString()
  @IsEnum(['transaction.success', 'transaction.failed'])
  event: string;
}
