import { IsObject, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreatePaiementKkiapayDto {
    @ApiProperty({ description: 'Id de la transaction' })
    @IsString()
    @Transform(({ value }) => String(value))
    transactionId: string;

    @ApiPropertyOptional({ description: 'Id de la commande' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value))
    orderId?: string;

    @ApiPropertyOptional({ description: 'Motif du paiement' })
    @IsObject()
    @IsOptional()
    @Transform(({ value }) => value)
    reason?: {
        code: string;
        description: string;
    };
}

