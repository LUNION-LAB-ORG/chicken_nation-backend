import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsNumber, IsOptional, IsString, IsUUID } from "class-validator";
import { Transform } from "class-transformer";

export class FraisLivraisonDto {
    @ApiProperty({ description: "Latitude" })
    @IsNumber()
    @Transform(({ value }) => Number(value))
    lat: number;

    @ApiProperty({ description: "Longitude" })
    @IsNumber()
    @Transform(({ value }) => Number(value))
    long: number;

    @ApiPropertyOptional()
    @IsUUID()
    @IsOptional()
    restaurant_id?: string;

    @ApiPropertyOptional({ description: "Sous-total (FCFA) — pour appliquer les offres conditionnées au montant" })
    @IsOptional()
    @IsNumber()
    @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
    order_amount?: number;

    @ApiPropertyOptional({ description: "Plats du panier, séparés par des virgules : pour les offres limitées à des menus ou des catégories" })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
    @IsArray()
    @ArrayMaxSize(100)
    @IsUUID('all', { each: true })
    dish_ids?: string[];

    @ApiPropertyOptional({ description: "Client de la commande en cours de saisie (personnel seulement, ignoré sinon)" })
    @IsOptional()
    @IsUUID()
    customer_id?: string;
}