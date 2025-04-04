import { IsString, IsNumber, IsBoolean, IsOptional, IsArray, ValidateNested, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMenuItemOptionDto {
  @IsString()
  name: string;

  @IsString()
  description: string;

  @IsNumber()
  additional_price: number;

  @IsBoolean()
  @IsOptional()
  is_available?: boolean;
}

export class CreateMenuItemDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  price: number;

  @IsString()
  @IsOptional()
  image?: string;

  @IsString()
  category_id: string;

  @IsString()
  @IsOptional()
  restaurant_id?: string;

  @IsBoolean()
  @IsOptional()
  is_available?: boolean;

  @IsBoolean()
  @IsOptional()
  is_new?: boolean;

  @IsString()
  @IsOptional()
  ingredients?: string;

  @IsNumber()
  @IsOptional()
  rating?: number;

  @IsNumber()
  @IsOptional()
  total_reviews?: number;

  @IsNumber()
  @IsOptional()
  discounted_price?: number;

  @IsNumber()
  @IsOptional()
  original_price?: number;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateMenuItemOptionDto)
  options?: CreateMenuItemOptionDto[];
}

export class UpdateMenuItemDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @IsOptional()
  price?: number;

  @IsString()
  @IsOptional()
  image?: string;

  @IsString()
  @IsOptional()
  category_id?: string;

  @IsString()
  @IsOptional()
  restaurant_id?: string;

  @IsBoolean()
  @IsOptional()
  is_available?: boolean;

  @IsBoolean()
  @IsOptional()
  is_new?: boolean;

  @IsString()
  @IsOptional()
  ingredients?: string;

  @IsNumber()
  @IsOptional()
  rating?: number;

  @IsNumber()
  @IsOptional()
  total_reviews?: number;

  @IsNumber()
  @IsOptional()
  discounted_price?: number;

  @IsNumber()
  @IsOptional()
  original_price?: number;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateMenuItemOptionDto)
  options?: CreateMenuItemOptionDto[];
}

export class PromotionDto {
  @IsBoolean()
  is_promoted: boolean;

  @IsNumber()
  @IsOptional()
  promotion_price?: number;
}