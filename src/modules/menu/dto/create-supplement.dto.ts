import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderType, SpiceLevel, SupplementCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSupplementDto {
    @ApiProperty({ description: 'Nom du supplément' })
    @IsNotEmpty()
    @IsString()
    name: string;

    @ApiProperty({ description: 'Prix du supplément' })
    @IsNotEmpty()
    @Transform(({ value }) => Number(value))    
    price: number;

    @ApiPropertyOptional({ description: 'Image du supplément', type:"file" as "string" })
    @IsOptional()
    @IsString()
    image?: string;

    @ApiPropertyOptional({ description: 'Disponibilité du supplément' })
    @IsOptional()
    @Transform(({ value }) => (value === undefined ? undefined : String(value).trim() === 'true'))
    available?: boolean = true;

    @ApiProperty({ enum: SupplementCategory, description: 'Catégorie du supplément', example: SupplementCategory.FOOD })
    @IsNotEmpty()
    @IsEnum(SupplementCategory)
    category: SupplementCategory;

    @ApiPropertyOptional({
        enum: SpiceLevel,
        description: 'Niveau épicé du supplément : ALWAYS (toujours), OPTIONAL (au choix), NEVER (jamais)',
        example: SpiceLevel.NEVER,
    })
    @IsOptional()
    @IsEnum(SpiceLevel)
    spice_level?: SpiceLevel;

    @ApiPropertyOptional({
        enum: OrderType,
        isArray: true,
        description: "Modes de commande où le supplément est disponible (défaut : tous).",
    })
    @IsOptional()
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') return undefined;
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
        return value;
    })
    @IsArray()
    @IsEnum(OrderType, { each: true })
    available_order_types?: OrderType[];

    @ApiPropertyOptional({ description: 'SKU HubRise pour la correspondance catalogue' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => value?.trim())
    hubrise_sku?: string;
}