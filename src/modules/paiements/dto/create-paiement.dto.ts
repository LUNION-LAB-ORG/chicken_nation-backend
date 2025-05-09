import { IsEnum, IsNumber, IsOptional, IsString, IsUUID } from "class-validator";
import { Transform } from "class-transformer";
import { PaiementMobileMoneyType, PaiementMode, PaiementStatus } from "@prisma/client";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreatePaiementDto {
    @ApiProperty({ description: 'Montant du paiement' })
    @IsNumber()
    @Transform(({ value }) => parseFloat(value))
    amount: number;

    @ApiPropertyOptional({ description: 'Id de la commande' })
    @IsUUID()
    @Transform(({ value }) => String(value))
    order_id?: string;

    @ApiProperty({ description: 'Mode de paiement', enum: PaiementMode })
    @IsEnum(PaiementMode)
    @Transform(({ value }) => String(value) as PaiementMode)
    mode: PaiementMode;

    @ApiPropertyOptional({ description: 'Type de paiement mobile money', enum: PaiementMobileMoneyType })
    @IsEnum(PaiementMobileMoneyType)
    @IsOptional()
    @Transform(({ value }) => String(value) as PaiementMobileMoneyType)
    mobile_money_type?: PaiementMobileMoneyType;

    @ApiProperty({ description: 'État du paiement', enum: PaiementStatus })
    @IsEnum(PaiementStatus)
    @Transform(({ value }) => String(value) as PaiementStatus)
    status: PaiementStatus = PaiementStatus.PENDING;

    @ApiProperty({ description: 'Référence du paiement' })
    @IsString()
    @Transform(({ value }) => String(value))
    reference: string;
}

    