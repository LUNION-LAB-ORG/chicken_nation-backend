import { SupplementCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateSupplementDto {
    @IsNotEmpty()
    @IsString()
    name: string;

    @IsNotEmpty()
    @IsNumber()
    price: number;

    @IsOptional()
    @IsString()
    image?: string;

    @IsOptional()
    @IsBoolean()
    available?: boolean = true;

    @IsNotEmpty()
    @IsEnum(SupplementCategory)
    @Transform(({ value }) => value.trim())
    category: SupplementCategory;
}