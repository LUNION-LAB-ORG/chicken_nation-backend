import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCategoryDto {

    @ApiProperty({ description: 'Nom de la catégorie' })
    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value.trim())
    name: string;

    @ApiProperty({ description: 'Description de la catégorie' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => value.trim())
    description?: string;

    @ApiProperty({ description: 'Image de la catégorie', type: "file" as "string", })
    @IsOptional()
    @IsString()
    image?: string;
}