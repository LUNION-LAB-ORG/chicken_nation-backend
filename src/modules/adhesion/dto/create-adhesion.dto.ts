import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ProfileType } from '@prisma/client';

/**
 * Corps de la pré-inscription publique (Tunnel d'adhésion, Phase 4).
 * Le téléphone est validé au format ivoirien (10 chiffres locaux `07xxxxxxxx`
 * OU E.164 `+2250700000000`) puis NORMALISÉ côté service en `225XXXXXXXXXX`
 * (voir AdhesionService.normalizePhone) pour rester idempotent avec le compte
 * pré-créé et le login OTP ultérieur (RG-07).
 */
export class CreateAdhesionDto {
  @ApiProperty({
    description: 'Nom (ou prénom) déclaré du client',
    example: 'Awa Koné',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @ApiProperty({
    description: 'Téléphone CI : 07xxxxxxxx (10 chiffres) ou +2250700000000',
    example: '+2250700000000',
    maxLength: 20,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  // Accepte : 07xxxxxxxx / 0700000000 (10 chiffres) OU +225 / 225 + 10 chiffres.
  @Matches(/^(\+?225)?\d{10}$/, {
    message:
      'Téléphone invalide. Attendu : 07xxxxxxxx (10 chiffres) ou +2250700000000',
  })
  phone: string;

  @ApiPropertyOptional({
    description:
      'Profil déclaratif : ETUDIANT si étudiant/élève. Absent = grand public.',
    enum: ProfileType,
    example: ProfileType.ETUDIANT,
  })
  @IsEnum(ProfileType)
  @IsOptional()
  profile_type?: ProfileType;

  @ApiPropertyOptional({
    description: "Établissement (école/université) — uniquement si étudiant/élève.",
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  establishment?: string;

  @ApiProperty({
    description: "Consentement à recevoir des messages WhatsApp (opt-in)",
    example: true,
  })
  // multipart/form-data : les booléens arrivent en string ("true"/"false").
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  whatsapp_opt_in: boolean;
}
