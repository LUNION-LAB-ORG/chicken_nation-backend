import { IsString, IsOptional, MaxLength, IsNotEmpty, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { parse, isValid } from 'date-fns';

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

  @ApiPropertyOptional({ description: 'Date de naissance du client', example: '1990-01-01' })
  @IsDateString({}, { message: 'La date de naissance doit être au format JJ/MM/AAAA' })
  @IsOptional()
  @Transform(({ value }) => {
    const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
    if (isValid(parsedDate)) {
      return parsedDate.toISOString();
    }
    return value;
  })
  birth_day?: string;
}
