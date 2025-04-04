import { IsString, IsOptional, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddFavoriteDto {
  @ApiProperty({ description: 'ID du restaurant à ajouter aux favoris', required: false })
  @IsString()
  @IsOptional()
  @ValidateIf(o => !o.productId)
  restaurantId?: string;

  @ApiProperty({ description: 'ID du produit à ajouter aux favoris', required: false })
  @IsString()
  @IsOptional()
  @ValidateIf(o => !o.restaurantId)
  productId?: string;
}
