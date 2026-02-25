import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupplementCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

    @ApiProperty({ enum: SupplementCategory, description: 'Catégorie du supplément', example: SupplementCategory.FOOD })
    @IsNotEmpty()
    @IsEnum(SupplementCategory)
    category: SupplementCategory;
}