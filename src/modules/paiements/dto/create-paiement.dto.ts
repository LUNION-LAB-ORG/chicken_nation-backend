import { IsEnum, IsNumber, IsOptional, IsString, IsUUID } from "class-validator";
import { Transform } from "class-transformer";
import { PaiementMode, PaiementStatus } from "@prisma/client";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreatePaiementDto {

    @ApiProperty({ description: 'Référence du paiement' })
    @IsString()
    @Transform(({ value }) => String(value))
    reference: string;

    @ApiProperty({ description: 'Montant du paiement' })
    @IsNumber()
    @Transform(({ value }) => parseFloat(value))
    amount: number;

    @ApiPropertyOptional({ description: 'Frais de la transaction' })
    @IsNumber()
    @IsOptional()
    @Transform(({ value }) => parseFloat(value))
    fees?: number;

    @ApiPropertyOptional({ description: 'Total du paiement' })
    @IsNumber()
    @IsOptional()
    @Transform(({ value }) => parseFloat(value))
    total?: number;

    @ApiProperty({ description: 'Mode de paiement', enum: PaiementMode })
    @IsEnum(PaiementMode)
    @Transform(({ value }) => String(value) as PaiementMode)
    mode: PaiementMode;

    @ApiPropertyOptional({ description: 'Type de paiement mobile money' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim().toUpperCase())
    source?: string;

    @ApiPropertyOptional({ description: "Client" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => typeof value !== "string" ? (typeof value == "object" ? JSON.stringify(value) : String(value)) : value)
    client?: string;

    @ApiProperty({ description: 'État du paiement', enum: PaiementStatus })
    @IsEnum(PaiementStatus)
    @Transform(({ value }) => String(value).trim().toUpperCase() as PaiementStatus)
    status: PaiementStatus;

    @ApiPropertyOptional({ description: 'Code d\'echec' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value))
    failure_code?: string;

    @ApiPropertyOptional({ description: 'Message d\'echec' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value))
    failure_message?: string;

    @ApiPropertyOptional({ description: 'Id de la commande' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value))
    order_id?: string;

    @ApiPropertyOptional({ description: 'Id du client' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value))
    client_id?: string;
}

