import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsArray, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { TicketPriority, TicketStatus } from "@prisma/client";

export class QueryTicketsDto {
    @ApiProperty({ required: false, default: 1 })
    @IsOptional() @IsNumber()
    @Min(1) @Type(() => Number)
    page?: number = 1;

    /**
     * ⚠️ Bornes resserrées, `@Min(0)` était deux fois piégeux.
     *
     * `limit=0` donnait une liste vide ET `totalPages = Math.ceil(total / 0)`,
     * soit `Infinity`, sérialisé en `null` dans le JSON : un défilement infini
     * qui lit `meta.totalPages` s'arrête net ou tourne en rond.
     *
     * Et sans plafond, chaque ticket de la liste embarquant jusqu'à cinquante
     * messages avec leurs auteurs, une page de 200 tickets ferait dix mille
     * messages dans une seule réponse.
     */
    @ApiProperty({ required: false, default: 10 })
    @IsOptional()
    @IsNumber() @Min(1) @Max(50)
    @Type(() => Number)
    limit?: number = 10;

    @ApiPropertyOptional({ description: 'Filtrer par statut(s)', enum: TicketStatus, isArray: true })
    @IsOptional()
    @Transform(({ value }) => Array.isArray(value) ? value : [value])
    @IsArray()
    @IsEnum(TicketStatus, { each: true })
    status?: TicketStatus[];

    @ApiPropertyOptional({ description: 'Filtrer par priorité(s)', enum: TicketPriority, isArray: true })
    @IsOptional()
    @Transform(({ value }) => Array.isArray(value) ? value : [value])
    @IsArray()
    @IsEnum(TicketPriority, { each: true })
    priority?: TicketPriority[];

    @ApiPropertyOptional({ description: 'Filtrer par catégorie(s)' })
    @IsOptional()
    @Transform(({ value }) => Array.isArray(value) ? value : [value])
    @IsArray()
    @IsString({ each: true })
    category?: string[];

    @ApiPropertyOptional({ description: 'Filtrer par assigné(s)' })
    @IsOptional()
    @Transform(({ value }) => Array.isArray(value) ? value : [value])
    @IsArray()
    @IsString({ each: true })
    assignedToId?: string[];

    @ApiPropertyOptional({ description: 'Filtrer par client' })
    @IsOptional()
    @IsString()
    clientId?: string;

    @ApiPropertyOptional({ description: 'Filtrer par restaurant' })
    @IsOptional()
    @IsString()
    restaurantId?: string;

    @ApiPropertyOptional({ description: 'Date de début' })
    @IsOptional()
    @IsDateString()
    dateFrom?: string;

    @ApiPropertyOptional({ description: 'Date de fin' })
    @IsOptional()
    @IsDateString()
    dateTo?: string;

    @ApiPropertyOptional({ description: 'Recherche textuelle (code, sujet, client)' })
    @IsOptional()
    @IsString()
    search?: string;
}
