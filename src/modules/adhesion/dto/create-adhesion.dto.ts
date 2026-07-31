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
  @ApiPropertyOptional({
    description:
      'Nom complet déclaré (LEGACY — préférer first_name/last_name). Découpé côté serveur : premier mot = prénom, reste = nom.',
    example: 'Awa Koné',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    description: 'Prénom(s) du client — prioritaire sur `name` quand fourni.',
    example: 'Awa',
    maxLength: 100,
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  first_name?: string;

  @ApiPropertyOptional({
    description: 'Nom de famille du client — prioritaire sur `name` quand fourni.',
    example: 'Koné',
    maxLength: 100,
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  last_name?: string;

  @ApiProperty({
    description:
      'Téléphone : local CI (0700000000) ou INTERNATIONAL avec indicatif (+221771234567). Plus aucune contrainte de pays.',
    example: '+2250700000000',
    maxLength: 20,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  // INTERNATIONAL (décision 30/07) : 8 à 15 chiffres, `+`/`00` optionnels,
  // espaces/points/tirets tolérés. La normalisation (défaut CI pour une saisie
  // locale à 10 chiffres) est faite dans AdhesionService.normalizePhone.
  @Matches(/^(\+|00)?[\d\s.\-()]{8,20}$/, {
    message:
      "Téléphone invalide. Attendu : 0700000000 (Côte d'Ivoire) ou indicatif pays complet (ex : +221771234567)",
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
