import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, Min } from 'class-validator';

export class CreateMenuItemOptionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  price?: number;

  @IsBoolean()
  @IsOptional()
  is_required?: boolean;
}

export class UpdateMenuItemOptionDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  price?: number;

  @IsBoolean()
  @IsOptional()
  is_required?: boolean;
}