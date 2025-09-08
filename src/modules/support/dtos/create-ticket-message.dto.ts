import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class CreateTicketMessageDto {
    @ApiProperty({ description: 'Corps du message' })
    @IsString()
    @IsNotEmpty()
    body: string;

    @ApiProperty({ description: 'ID du ticket associé' })
    @IsString()
    @IsNotEmpty()
    ticketId: string;

    @ApiProperty({ description: 'Indique si le message est interne (non visible par le client)', default: false })
    @IsNotEmpty()
    internal: boolean;

    @ApiProperty({ description: 'ID de l\'auteur du message (utilisateur ou client)' })
    @IsString()
    @IsNotEmpty()
    authorId: string;

    @ApiProperty({ description: 'Type de l\'auteur (USER ou CUSTOMER)' })
    @IsString()
    @IsNotEmpty()
    authorType: 'USER' | 'CUSTOMER';

    @ApiProperty({ description: 'Métadonnées supplémentaires', required: false })
    @IsString()
    meta?: string;
}