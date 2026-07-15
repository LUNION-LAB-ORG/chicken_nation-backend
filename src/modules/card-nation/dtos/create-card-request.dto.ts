import { IsString, IsOptional, MaxLength, IsNotEmpty, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { parse, isValid } from 'date-fns';
import { ProfileType } from '@prisma/client';

export class CreateCardRequestDto {
  @ApiPropertyOptional({ description: 'Surnom pour la carte', example: 'Johnny', maxLength: 100 })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => (value ? value.trim() : value))
  nickname?: string;

  @ApiProperty({
    description: 'Profil déclaratif du client (V1 sans justificatif)',
    enum: ProfileType,
    example: ProfileType.ETUDIANT,
  })
  @IsEnum(ProfileType, { message: 'Le profil doit être ETUDIANT ou PROFESSIONNEL' })
  @IsNotEmpty({ message: 'Le profil (ETUDIANT / PROFESSIONNEL) est requis' })
  profile_type: ProfileType;

  @ApiPropertyOptional({
    description:
      "Nom de l'établissement — requis UNIQUEMENT en mode V2 (card.require_justificatif=true)",
    example: 'Université Félix Houphouët-Boigny',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  @Transform(({ value }) => (value ? value.trim() : value))
  institution?: string;

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
