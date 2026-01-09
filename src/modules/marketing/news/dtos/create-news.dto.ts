import { IsString, IsOptional, MaxLength, IsNotEmpty, IsBoolean, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateNewsDto {
  @ApiProperty({ description: 'Titre de la nouveauté', example: 'Nouvelle offre étudiante' })
  @IsString()
  @IsNotEmpty({ message: 'Le titre est requis' })
  @MaxLength(255)
  @Transform(({ value }) => value.trim())
  title: string;

  @ApiPropertyOptional({ description: 'Contenu de la nouveauté', example: 'Profitez de -20% sur tous nos menus...' })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => (value ? value.trim() : value))
  content?: string;

  @ApiPropertyOptional({ description: 'Lien externe ou deeplink', example: 'https://example.com/promo' })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => (value ? value.trim() : value))
  link?: string;

  @ApiPropertyOptional({ description: 'Statut de publication', example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;
}