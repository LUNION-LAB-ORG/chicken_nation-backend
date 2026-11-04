import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ETATS_FILLEUL,
  ETATS_PARRAIN,
  EtatFilleul,
  EtatParrain,
  TRIS_PARRAIN,
  TriParrain,
} from '../referral-pilotage.sql';

const PERIODES = ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'year'] as const;

/** Période des chiffres. Sans période ni dates : tout le programme. */
export class PeriodeParrainageQueryDto {
  @ApiPropertyOptional({ enum: PERIODES, description: 'Période prédéfinie' })
  @IsOptional()
  @IsIn(PERIODES)
  period?: (typeof PERIODES)[number];

  @ApiPropertyOptional({ description: 'Date de début (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Date de fin (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

/** Liste des parrains (backoffice). */
export class ListeParrainsQueryDto extends PeriodeParrainageQueryDto {
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

  @ApiPropertyOptional({ enum: ETATS_PARRAIN, description: 'Avec filleuls, payable…' })
  @IsOptional()
  @IsIn(ETATS_PARRAIN)
  etat?: EtatParrain;

  @ApiPropertyOptional({ enum: TRIS_PARRAIN, description: 'Tri, du plus grand au plus petit (défaut : filleuls)' })
  @IsOptional()
  @IsIn(TRIS_PARRAIN)
  tri?: TriParrain;
}

/** Liste de tous les filleuls (backoffice). */
export class ListeFilleulsQueryDto extends PeriodeParrainageQueryDto {
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

  @ApiPropertyOptional({ description: 'Nom, code ou téléphone du filleul ou de son parrain' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ enum: ETATS_FILLEUL })
  @IsOptional()
  @IsIn(ETATS_FILLEUL)
  etat?: EtatFilleul;
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
