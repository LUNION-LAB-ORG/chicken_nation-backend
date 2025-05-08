import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDishDto {
    @ApiProperty({ description: 'Nom du plat' })
    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value.trim())
    name: string;

    @ApiPropertyOptional({ description: 'Description du plat' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => value.trim())
    description?: string;

    @ApiProperty({ description: 'Prix du plat' })
    @IsNotEmpty()
    @IsNumber()
    @Transform(({ value }) => Number(value))
    price: number;

    @ApiPropertyOptional({ description: 'Image du plat', type: "file" as "string" })
    @IsOptional()
    @IsString()
    image?: string;

    @ApiPropertyOptional({ description: 'Promotion du plat' })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    is_promotion?: boolean = false;

    @ApiPropertyOptional({ description: 'Prix de promotion du plat' })
    @IsOptional()
    @IsNumber()
    @Transform(({ value }) => Number(value))
    promotion_price?: number;

    @ApiProperty({ description: 'ID de la catégorie', example: '123' })
    @IsNotEmpty()
    @IsUUID()
    category_id: string;

    @ApiPropertyOptional({ description: 'ID des restaurants', example: ['123', '456'] })
    @IsOptional()
    @IsUUID(undefined, { each: true })
    restaurant_ids?: string[];

    @ApiPropertyOptional({ description: 'ID des suppléments', example: ['123', '456'] })
    @IsOptional()
    @IsUUID(undefined, { each: true })
    supplement_ids?: string[];
}