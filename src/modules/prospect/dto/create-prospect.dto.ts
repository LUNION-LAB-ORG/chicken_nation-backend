import { IsString, IsNotEmpty, IsEnum, Matches, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ProspectPlatform } from '@prisma/client';

/**
 * Saisie d'un contact Glovo/Yango par un agent store (caissier/manager).
 * Les 4 champs sont obligatoires (cf. cahier des charges §4.3).
 */
export class CreateProspectDto {
  @ApiProperty({ enum: ProspectPlatform, example: ProspectPlatform.GLOVO })
  @IsEnum(ProspectPlatform, { message: 'Plateforme invalide (GLOVO ou YANGO)' })
  platform: ProspectPlatform;

  @ApiProperty({ description: 'Nom / prénom / pseudo utilisé pour la commande', example: 'Kouamé' })
  @IsString()
  @IsNotEmpty({ message: 'Le nom est obligatoire' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @ApiProperty({ description: 'Numéro de la commande Glovo/Yango', example: '101672547192' })
  @IsString()
  @IsNotEmpty({ message: 'Le numéro de commande est obligatoire' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  order_number: string;

  @ApiProperty({ description: 'Téléphone ivoirien (10 chiffres, +225 accepté)', example: '0700000000' })
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    let d = value.replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('225') && d.length === 13) d = d.slice(3); // +225 / 00225 → 10 chiffres locaux
    return d;
  })
  @Matches(/^\d{10}$/, { message: 'Le numéro de téléphone doit comporter 10 chiffres' })
  phone: string;

  @ApiPropertyOptional({
    description: "Store de saisie. Ignoré pour un agent store (forcé à son restaurant) ; requis pour l'admin central.",
  })
  @IsOptional()
  @IsUUID()
  restaurant_id?: string;
}
