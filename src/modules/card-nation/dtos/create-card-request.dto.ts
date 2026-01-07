import { IsString, IsOptional, MaxLength, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateCardRequestDto {
  @ApiPropertyOptional({ description: 'Surnom pour la carte', example: 'Johnny', maxLength: 100 })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => (value ? value.trim() : value))
  nickname?: string;

  @ApiProperty({ description: 'Nom de l\'établissement', example: 'Université Félix Houphouët-Boigny' })
  @IsString()
  @IsNotEmpty({ message: 'Le nom de l\'établissement est requis' })
  @MaxLength(255)
  @Transform(({ value }) => value.trim())
  institution: string;
}
