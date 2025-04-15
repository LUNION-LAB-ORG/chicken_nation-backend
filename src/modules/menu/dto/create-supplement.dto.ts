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
    @IsNumber()
    price: number;

    @ApiPropertyOptional({ description: 'Image du supplément' })
    @IsOptional()
    @IsString()
    image?: string;

    @ApiPropertyOptional({ description: 'Disponibilité du supplément' })
    @IsOptional()
    @IsBoolean()
    available?: boolean = true;

    @ApiProperty({ description: 'Catégorie du supplément' })
    @IsNotEmpty()
    @IsEnum(SupplementCategory)
    @Transform(({ value }) => value.trim())
    category: SupplementCategory;
}