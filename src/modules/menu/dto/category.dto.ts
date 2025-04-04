import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsUrl } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'L\'URL de l\'image doit être valide' })
  image?: string;
}

export class UpdateCategoryDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'L\'URL de l\'image doit être valide' })
  image?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}