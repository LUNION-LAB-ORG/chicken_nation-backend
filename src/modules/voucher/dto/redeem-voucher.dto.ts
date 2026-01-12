import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsUUID, Min } from 'class-validator';

export class RedeemVoucherDto {
    @ApiProperty({ description: 'ID de la commande', example: '123e4567-e89b-12d3-a456-426614174000' })
    @IsNotEmpty()
    @IsUUID()
    orderId: string;

    @ApiProperty({ description: 'Montant du bon', example: 100.0 })
    @IsNotEmpty()
    @IsNumber()
    @Min(0.01, { message: 'Le montant doit être supérieur à 0' })
    amount: number;
}
