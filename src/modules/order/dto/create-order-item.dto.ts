import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested } from "class-validator";
import { QUANTITE_MAX_LIGNE } from "./order-create.dto";
import { Transform, Type } from "class-transformer";

/**
 * Supplément avec quantité (nouveau format backoffice, identique au mobile V2).
 * { id: "uuid-du-supplement", quantity: 2 }
 */
export class SupplementItemBackofficeDto {
    @IsUUID()
    id: string;

    @IsInt()
    @Min(1)
    @Max(QUANTITE_MAX_LIGNE)
    @Transform(({ value }) => Number(value))
    quantity: number;
}

export class CreateOrderItemDto {
    @ApiProperty({ description: "ID du plat" })
    @IsUUID()
    dish_id: string;

    @ApiProperty({ description: "Quantité commandée", minimum: 1, maximum: QUANTITE_MAX_LIGNE, default: 1 })
    @IsInt()
    @Min(1)
    @Max(QUANTITE_MAX_LIGNE)
    @Transform(({ value }) => Number(value))
    quantity: number;

    @ApiPropertyOptional({ description: "IDs des suppléments choisis (ancien format)", type: [String] })
    @IsOptional()
    @IsArray()
    @IsUUID(undefined, { each: true })
    supplements_ids?: string[];

    @ApiPropertyOptional({ description: "Suppléments avec quantité (nouveau format)", type: [SupplementItemBackofficeDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SupplementItemBackofficeDto)
    supplements?: SupplementItemBackofficeDto[];

    @ApiPropertyOptional({ description: "ID de la promotion" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    @IsBoolean()
    epice: boolean;

    @ApiPropertyOptional({
        description:
            "MENUS COMPOSABLES : identifiants des choix retenus (sauce, format). Le serveur " +
            "retrouve leur prix en base et vérifie les bornes du plat.",
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @IsUUID(undefined, { each: true })
    option_item_ids?: string[];
}