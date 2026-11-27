import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

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

    @ApiProperty({ description: "Type de l'auteur (USER, CUSTOMER ou DELIVERER)" })
    @IsString()
    authorType?: 'USER' | 'CUSTOMER' | 'DELIVERER';

    @ApiProperty({ description: 'Métadonnées supplémentaires', required: false })
    @IsString()
    meta?: string;
}

/**
 * Message écrit par le CLIENT dans son ticket (27/11) : du texte, une note
 * vocale, ou les deux.
 *
 * Le formulaire à pièce jointe n'envoie que des chaînes, et l'auteur, le
 * ticket et « interne » viennent du jeton et de l'adresse, jamais du corps :
 * tout est donc facultatif ici. Les anciens champs restent déclarés pour que
 * l'appli déjà installée, qui les envoie, ne soit pas refusée.
 */
export class CreateCustomerTicketMessageDto {
    @ApiProperty({ description: 'Texte du message ; facultatif avec une note vocale', required: false })
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    body?: string;

    @ApiProperty({ description: 'Durée de la note vocale, en millisecondes', required: false })
    @IsOptional()
    audioDurationMs?: string | number;

    @IsOptional()
    ticketId?: string;

    @IsOptional()
    internal?: boolean | string;

    @IsOptional()
    authorId?: string;

    @IsOptional()
    authorType?: string;

    @IsOptional()
    meta?: unknown;
}
