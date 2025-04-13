import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateCategoryDto {
    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value.trim())
    name: string;

    @IsOptional()
    @IsString()
    @Transform(({ value }) => value.trim())
    description?: string;

    @IsOptional()
    @IsString()
    image?: string;
}