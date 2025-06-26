import { IsEnum, IsUUID, IsOptional, IsNumber, Min, IsString, IsDateString } from 'class-validator';
import { OrderStatus, OrderType } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { parse, isValid } from 'date-fns';

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
}