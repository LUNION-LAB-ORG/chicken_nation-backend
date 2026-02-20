import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMinSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsBoolean, IsUUID, ValidateNested, IsNumber, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { OrderType } from "src/modules/order/enums/order-type.enum";

export class SupplementItemDto {
    @IsUUID()
    id: string;
    @IsNumber()
    quantity: number;
}

export class OrderItemDto {
    @ApiProperty({ description: "ID du plat" })
    @IsUUID()
    dish_id: string;

    @ApiProperty({ description: "Quantité commandée", minimum: 1, default: 1 })
    @IsNumber()
    @Min(1)
    @Transform(({ value }) => Number(value))
    quantity: number;

    @ApiPropertyOptional({ description: "IDs des suppléments choisis", type: [Object] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SupplementItemDto)
    supplements?: SupplementItemDto[];

    @ApiPropertyOptional({ description: "ID de la promotion" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    @IsBoolean()
    epice: boolean;
}

export class OrderCreateDto {
    @ApiProperty({ description: "Type de commande", enum: OrderType })
    @IsEnum(OrderType)
    type: OrderType;

    @ApiPropertyOptional({ description: "l'adresse de livraison/retrait" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => typeof value !== "string" ? (typeof value == "object" ? JSON.stringify(value) : String(value)) : value)
    address?: string;

    @ApiPropertyOptional({ description: "Code promo" })
    @IsOptional()
    @IsString()
    code_promo?: string;

    @ApiPropertyOptional({ description: "Date et heure complètes de récupération (ISO 8601)" })
    @IsOptional()
    @IsDateString({}, { message: 'La date doit être au format ISO 8601 valide (ex: 2026-02-20T09:07:00.000Z)' })
    @Transform(({ value }) => {
        // On s'assure que c'est une date valide, sinon on prend la date actuelle par sécurité
        const parsedDate = typeof value === "string" ? new Date(value) : value;
        if (!isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString(); // Retourne le datetime complet
        }
        return new Date().toISOString();
    })
    date?: string;

    @ApiPropertyOptional({ description: "Nom complet du client" })
    @IsOptional()
    @IsString()
    fullname?: string;

    @ApiPropertyOptional({ description: 'Numéro de téléphone du client', example: '+225070707070' })
    @IsOptional()
    // @IsPhoneNumber("CI", { message: 'Numéro de téléphone non valide, utilisez le format +225' })
    @IsString()
    @Transform(({ value }) => value.trim())
    phone?: string;

    @ApiPropertyOptional({ description: "Email du client" })
    @IsOptional()
    @IsString()
    email?: string;

    @ApiProperty({ description: "Éléments de la commande", type: [OrderItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @ArrayMinSize(1)
    @Type(() => OrderItemDto)
    items: OrderItemDto[];

    @ApiPropertyOptional({ description: "ID du restaurant" })
    @IsOptional()
    @IsUUID()
    restaurant_id?: string;

    @ApiPropertyOptional({ description: "Points de fidélité à utiliser" })
    @IsOptional()
    @IsInt()
    @Type(() => Number)
    points?: number;

    @ApiPropertyOptional({ description: "ID de la promotion" })
    @IsOptional()
    @IsUUID()
    promotion_id?: string;

    @ApiPropertyOptional({ description: "Frais de livraison" })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    delivery_fee?: number;
}