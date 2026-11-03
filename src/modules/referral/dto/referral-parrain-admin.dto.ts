import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Liste des parrains (backoffice). */
export class ListeParrainsQueryDto {
  @ApiPropertyOptional({ description: 'Page (défaut 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Taille de page (défaut 10, max 50)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Nom, code ou téléphone' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

/** Recherche d'un client à faire parrain ou filleul. */
export class ChercherClientsQueryDto {
  @ApiPropertyOptional({ description: 'Nom, code ou téléphone (2 caractères au moins)' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

/** Fait d'un client un parrain. Sans code, il reçoit CN-PRENOM. */
export class CreerParrainDto {
  @ApiProperty({ description: 'Client qui devient parrain' })
  @IsUUID()
  customer_id!: string;

  @ApiPropertyOptional({ description: 'Code choisi, ex. CN-AWA', example: 'CN-AWA' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  code?: string;
}

/** Nouveau code d'un parrain. */
export class ChangerCodeParrainDto {
  @ApiProperty({ description: 'Nouveau code, ex. CN-AWA', example: 'CN-AWA' })
  @IsString()
  @MaxLength(24)
  code!: string;
}

/** Filleul rattaché à la main (code oublié à l'inscription). */
export class RattacherFilleulDto {
  @ApiProperty({ description: 'Client à rattacher comme filleul' })
  @IsUUID()
  customer_id!: string;
}

/** Versement de tout le solde payable d'un parrain. */
export class VerserParrainDto {
  @ApiProperty({ description: 'Montant versé (FCFA), égal au solde payable' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({ description: 'Référence du versement (Wave, espèces…)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
