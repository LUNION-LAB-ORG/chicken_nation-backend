import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDishDto {
    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value.trim())
    name: string;

    @IsOptional()
    @IsString()
    @Transform(({ value }) => value.trim())
    description?: string;

    @IsNotEmpty()
    @IsNumber()
    price: number;

    @IsOptional()
    @IsString()
    image?: string;

    @IsOptional()
    @IsBoolean()
    available?: boolean = true;

    @IsOptional()
    @IsBoolean()
    is_promotion?: boolean = false;

    @IsOptional()
    @IsNumber()
    promotion_price?: number;

    @IsNotEmpty()
    @IsUUID()
    category_id: string;

    @IsOptional()
    @IsUUID('4', { each: true })
    restaurant_ids?: string[];

    @IsOptional()
    @IsUUID('4', { each: true })
    supplement_ids?: string[];
}