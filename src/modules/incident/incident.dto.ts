import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IncidentGeste,
  IncidentGravite,
  IncidentOrigine,
  IncidentPole,
  IncidentRecontact,
  IncidentStatut,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DESCRIPTION_MAX,
  MESSAGE_CONFLIT,
  MESSAGE_GESTE,
  MESSAGE_ORIGINE,
  MESSAGE_RECONTACT,
  MOTIF_MAX,
  NOTE_MAX,
  TEXTE_MAX,
} from './incident.rules';

const rogner = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const vide = ({ value }: { value: unknown }) => (value === '' ? undefined : value);
const JOUR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Corps et filtres des incidents sur commande. Les longueurs maximales sont
 * gardées ici (un corps énorme n'atteint pas le service) ; le sens des textes
 * (minimum, message exact) l'est dans `incident.rules.ts`.
 */

// ─── Signaler ────────────────────────────────────────────────────────────────

export class SignalerIncidentDto {
  @ApiProperty()
  @IsUUID('all', { message: 'Commande introuvable.' })
  order_id: string;

  @ApiProperty()
  @IsUUID('all', { message: 'Choisissez la catégorie.' })
  categorie_id: string;

  @ApiProperty({ enum: IncidentGravite })
  @IsEnum(IncidentGravite, { message: 'Choisissez la gravité.' })
  gravite: IncidentGravite;

  @ApiPropertyOptional({ enum: IncidentOrigine, description: 'Ignorée quand un lien (ticket, avis, note) est donné' })
  @IsOptional()
  @IsEnum(IncidentOrigine, { message: MESSAGE_ORIGINE })
  origine?: IncidentOrigine;

  @ApiProperty({ maxLength: DESCRIPTION_MAX })
  @Transform(rogner)
  @IsString({ message: 'Décrivez le problème.' })
  @MaxLength(DESCRIPTION_MAX, { message: 'La description ne doit pas dépasser 2 000 caractères.' })
  description: string;

  @ApiPropertyOptional({ description: "Ticket d'où vient le signalement" })
  @IsOptional()
  @IsUUID('all')
  ticket_id?: string;

  @ApiPropertyOptional({ description: 'Retour privé « Ton avis compte »' })
  @IsOptional()
  @IsUUID('all')
  avis_id?: string;

  @ApiPropertyOptional({ description: 'Note après commande' })
  @IsOptional()
  @IsUUID('all')
  comment_id?: string;
}

// ─── Gestes ──────────────────────────────────────────────────────────────────

/** Statut que l'agent avait sous les yeux : changé entre-temps, le serveur refuse (409). */
class StatutLuDto {
  @ApiProperty({ enum: IncidentStatut })
  @IsEnum(IncidentStatut, { message: MESSAGE_CONFLIT })
  statut_lu: IncidentStatut;
}

/** Sans `pole` ni `agent_id` : « Prendre en charge » (En cours, à mon nom). */
export class AssignerIncidentDto extends StatutLuDto {
  @ApiPropertyOptional({ enum: IncidentPole })
  @IsOptional()
  @IsEnum(IncidentPole, { message: 'Choisissez le responsable.' })
  pole?: IncidentPole;

  @ApiPropertyOptional({ nullable: true, description: 'null retire l’agent' })
  @ValidateIf((o: AssignerIncidentDto) => o.agent_id !== undefined && o.agent_id !== null)
  @IsUUID('all', { message: 'Agent introuvable.' })
  agent_id?: string | null;
}

export class ResoudreIncidentDto extends StatutLuDto {
  @ApiProperty({ maxLength: TEXTE_MAX })
  @Transform(rogner)
  @IsString({ message: 'Indiquez la cause.' })
  @MaxLength(TEXTE_MAX, { message: 'Ce texte ne doit pas dépasser 1 000 caractères.' })
  cause: string;

  @ApiProperty({ maxLength: TEXTE_MAX })
  @Transform(rogner)
  @IsString({ message: "Indiquez l'action corrective." })
  @MaxLength(TEXTE_MAX, { message: 'Ce texte ne doit pas dépasser 1 000 caractères.' })
  action: string;

  @ApiProperty({ enum: IncidentGeste })
  @IsEnum(IncidentGeste, { message: MESSAGE_GESTE })
  geste: IncidentGeste;

  @ApiPropertyOptional({ description: 'Montant du bon (barème), seulement pour le geste BON' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Choisissez un montant du barème.' })
  bon_montant?: number;
}

export class CloturerIncidentDto extends StatutLuDto {
  @ApiProperty({ enum: IncidentRecontact })
  @IsEnum(IncidentRecontact, { message: MESSAGE_RECONTACT })
  recontact: IncidentRecontact;

  @ApiPropertyOptional({ maxLength: TEXTE_MAX })
  @IsOptional()
  @Transform(rogner)
  @IsString()
  @MaxLength(TEXTE_MAX, { message: 'Ce texte ne doit pas dépasser 1 000 caractères.' })
  reaction?: string;
}

export class RouvrirIncidentDto extends StatutLuDto {
  @ApiProperty({ maxLength: MOTIF_MAX })
  @Transform(rogner)
  @IsString({ message: 'Indiquez pourquoi vous rouvrez.' })
  @MaxLength(MOTIF_MAX, { message: 'Le motif ne doit pas dépasser 500 caractères.' })
  motif: string;
}

export class NoteIncidentDto {
  @ApiProperty({ maxLength: NOTE_MAX })
  @Transform(rogner)
  @IsString({ message: 'Écrivez la note.' })
  @MaxLength(NOTE_MAX, { message: 'La note ne doit pas dépasser 2 000 caractères.' })
  note: string;
}

// ─── Filtres ─────────────────────────────────────────────────────────────────

export class FiltresIncidentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(vide)
  @IsUUID('all')
  restaurantId?: string;

  @ApiPropertyOptional({ enum: IncidentPole })
  @IsOptional()
  @Transform(vide)
  @IsEnum(IncidentPole)
  pole?: IncidentPole;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(vide)
  @IsUUID('all')
  categorieId?: string;

  @ApiPropertyOptional({ enum: IncidentGravite })
  @IsOptional()
  @Transform(vide)
  @IsEnum(IncidentGravite)
  gravite?: IncidentGravite;

  @ApiPropertyOptional({ description: 'Code, référence de commande, nom ou téléphone du client' })
  @IsOptional()
  @Transform(rogner)
  @IsString()
  @MaxLength(60)
  recherche?: string;
}

export class ListeIncidentDto extends FiltresIncidentDto {
  @ApiPropertyOptional({ enum: IncidentStatut })
  @IsOptional()
  @Transform(vide)
  @IsEnum(IncidentStatut)
  statut?: IncidentStatut;

  @ApiPropertyOptional({ enum: IncidentOrigine })
  @IsOptional()
  @Transform(vide)
  @IsEnum(IncidentOrigine)
  origine?: IncidentOrigine;

  @ApiPropertyOptional({ description: 'Incidents de ce client (fiche du CRM)' })
  @IsOptional()
  @Transform(vide)
  @IsUUID('all')
  customerId?: string;

  @ApiPropertyOptional({ description: 'Signalés à partir du (AAAA-MM-JJ)' })
  @IsOptional()
  @Transform(vide)
  @Matches(JOUR, { message: 'Date invalide.' })
  du?: string;

  @ApiPropertyOptional({ description: "Signalés jusqu'au (AAAA-MM-JJ), jour compris" })
  @IsOptional()
  @Transform(vide)
  @Matches(JOUR, { message: 'Date invalide.' })
  au?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class StatistiquesIncidentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(vide)
  @IsUUID('all')
  restaurantId?: string;

  @ApiPropertyOptional({ description: 'AAAA-MM-JJ ; 30 derniers jours par défaut' })
  @IsOptional()
  @Transform(vide)
  @Matches(JOUR, { message: 'Date invalide.' })
  du?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(vide)
  @Matches(JOUR, { message: 'Date invalide.' })
  au?: string;
}

export class PorteeIncidentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(vide)
  @IsUUID('all')
  restaurantId?: string;
}

export class RechercheCommandeDto {
  @ApiProperty({ description: 'Référence, nom ou téléphone' })
  @Transform(rogner)
  @IsString()
  @MaxLength(60)
  recherche: string;
}

// ─── Réglages ────────────────────────────────────────────────────────────────

export class CreerCategorieIncidentDto {
  @ApiProperty()
  @Transform(rogner)
  @IsString({ message: 'Donnez un nom à la catégorie.' })
  @MaxLength(120)
  nom: string;

  @ApiProperty({ enum: IncidentPole })
  @IsEnum(IncidentPole, { message: 'Choisissez le responsable.' })
  pole: IncidentPole;

  @ApiProperty({ description: 'Délai cible, en heures' })
  @Type(() => Number)
  @IsInt({ message: 'Le délai va de 1 à 720 heures.' })
  delai_heures: number;
}

export class ModifierCategorieIncidentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(rogner)
  @IsString()
  @MaxLength(120)
  nom?: string;

  @ApiPropertyOptional({ enum: IncidentPole })
  @IsOptional()
  @IsEnum(IncidentPole, { message: 'Choisissez le responsable.' })
  pole?: IncidentPole;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Le délai va de 1 à 720 heures.' })
  delai_heures?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  actif?: boolean;
}

class BaremeDto {
  @Type(() => Number)
  @IsInt({ message: 'Les montants vont de 100 à 100 000 F.' })
  FAIBLE: number;

  @Type(() => Number)
  @IsInt({ message: 'Les montants vont de 100 à 100 000 F.' })
  MOYENNE: number;

  @Type(() => Number)
  @IsInt({ message: 'Les montants vont de 100 à 100 000 F.' })
  HAUTE: number;
}

export class ReglagesIncidentDto {
  @ApiPropertyOptional({ description: 'Montant du bon selon la gravité' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BaremeDto)
  bareme?: BaremeDto;

  @ApiPropertyOptional({ description: 'Validité du bon, en jours' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La validité va de 1 à 365 jours.' })
  validite_jours?: number;

  @ApiPropertyOptional({ description: 'Manager et assistant peuvent offrir un bon' })
  @IsOptional()
  @IsBoolean()
  bon_restaurant?: boolean;
}
