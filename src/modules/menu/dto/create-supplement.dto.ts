import { SupplementCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
    @Transform(({ value }) => Boolean(value))
    available?: boolean = true;

    @ApiProperty({ description: 'Catégorie du supplément', example: "FOOD | DRINK | ACCESSORY" })
    @IsNotEmpty()
    @IsEnum(SupplementCategory)
    @Transform(({ value }) => value.trim().toUpperCase() as SupplementCategory)
    category: SupplementCategory;
}