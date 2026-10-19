import { IsEnum, IsUUID, IsOptional, IsNumber, Min, IsString, IsDateString, IsBoolean, IsIn } from 'class-validator';
import { OrderStatus, OrderType } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { parse, isValid } from 'date-fns';
import { SOURCES_COMMANDE, SourceCommande } from '../helpers/canal-commande.rules';

export class QueryOrderDto {
    @ApiPropertyOptional({ description: "Filtrer par statut de commande", enum: OrderStatus })
    @IsOptional()
    @IsEnum(OrderStatus)
    status?: OrderStatus;

    @ApiPropertyOptional({ description: "Filtrer par type de commande", enum: OrderType })
    @IsOptional()
    @IsEnum(OrderType)
    type?: OrderType;

    @ApiPropertyOptional({ description: "Filtrer par ID de client" })
    @IsOptional()
    @IsUUID()
    customerId?: string;

    @ApiPropertyOptional({ description: "Filtrer par ID de restaurant" })
    @IsOptional()
    @IsUUID()
    restaurantId?: string;

    @ApiPropertyOptional({ description: "Date de début pour filtrer les commandes" })
    @IsOptional()
    @IsDateString({}, { message: 'La date de début doit être au format JJ/MM/AAAA' })
    @Transform(({ value }) => {
        const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
        if (isValid(parsedDate)) {
            return parsedDate.toISOString();
        }
        return value;
    })
    startDate?: Date;

    @ApiPropertyOptional({ description: "Date de fin pour filtrer les commandes" })
    @IsOptional()
    @IsDateString({}, { message: 'La date de fin doit être au format JJ/MM/AAAA' })
    @Transform(({ value }) => {
        const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
        if (isValid(parsedDate)) {
            return parsedDate.toISOString();
        }
        return value;
    })
    endDate?: Date;

    @ApiPropertyOptional({ description: "Montant minimum de commande" })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    minAmount?: number;

    @ApiPropertyOptional({ description: "Montant maximum de commande" })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    maxAmount?: number;

    @ApiPropertyOptional({ description: "Numéro de page", default: 1 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    page?: number;

    @ApiPropertyOptional({ description: "Nombre d'éléments par page", default: 10 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    limit?: number;

    @ApiPropertyOptional({ description: "Champ de tri", default: "created_at" })
    @IsOptional()
    @IsString()
    sortBy?: string;

    @ApiPropertyOptional({ description: "Ordre de tri (asc/desc)", default: "desc" })
    @IsOptional()
    @IsString()
    sortOrder?: 'asc' | 'desc';

    @ApiPropertyOptional({ description: "Rechercher une commande par son numéro de référence" })
    @IsOptional()
    @IsString()
    reference?: string;


    @ApiPropertyOptional({ description: "Commande automatique" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    @IsBoolean()
    auto?: boolean;

    /**
     * Source de la commande (filtre « Toutes les sources » du backoffice).
     * Facultatif ; quand il est là, il prime sur `auto`. Règle et valeurs
     * nulles : helpers/canal-commande.rules.ts (`conditionSource`).
     */
    @ApiPropertyOptional({
        description:
            "Source de la commande : site (site web), appli (application, commandes sans canal comprises) " +
            "ou telephone (saisie du personnel, commandes du site reprises au téléphone comprises). " +
            "Prime sur `auto`. Lu par la liste, l'export Excel et le tableau des livraisons par restaurant.",
        enum: [...SOURCES_COMMANDE],
    })
    @IsOptional()
    @Transform(({ value }) => (value === '' ? undefined : value))
    @IsIn(SOURCES_COMMANDE)
    source?: SourceCommande;

    @ApiPropertyOptional({ description: "Pagination" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    @IsBoolean()
    pagination?: boolean;
}


export class QueryOrderCustomerDto {
    @ApiPropertyOptional({ description: "Filtrer par statut de commande", enum: ["processing", "completed", "cancelled"] })
    @IsOptional()
    status?: "processing" | "completed" | "cancelled";

    @ApiPropertyOptional({ description: "Date de début pour filtrer les commandes" })
    @IsOptional()
    @IsDateString({}, { message: 'La date de début doit être au format JJ/MM/AAAA' })
    @Transform(({ value }) => {
        const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
        if (isValid(parsedDate)) {
            return parsedDate.toISOString();
        }
        return value;
    })
    startDate?: Date;

    @ApiPropertyOptional({ description: "Date de fin pour filtrer les commandes" })
    @IsOptional()
    @IsDateString({}, { message: 'La date de fin doit être au format JJ/MM/AAAA' })
    @Transform(({ value }) => {
        const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
        if (isValid(parsedDate)) {
            return parsedDate.toISOString();
        }
        return value;
    })
    endDate?: Date;

    @ApiPropertyOptional({ description: "Montant minimum de commande" })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    minAmount?: number;

    @ApiPropertyOptional({ description: "Montant maximum de commande" })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    maxAmount?: number;

    @ApiPropertyOptional({ description: "Numéro de page", default: 1 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    page?: number;

    @ApiPropertyOptional({ description: "Nombre d'éléments par page", default: 10 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    limit?: number;
}