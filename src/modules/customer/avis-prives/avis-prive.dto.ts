import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvisCanal, AvisResultat, AvisRessenti, AvisSolution, AvisStatut } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ACTIONS_JOURNAL, ActionJournal, COMMENTAIRE_MAX, COMMENTAIRE_MIN, MESSAGE_COMMENTAIRE, NOTE_MAX, PRENOM_MAX } from './avis-prive.rules';

const rogner = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Corps de l'envoi PUBLIC (page /fr/avis, par le serveur du site). Messages en
 * français : le site les affiche tels quels.
 */
export class CreerAvisPriveDto {
  @ApiProperty({ enum: AvisRessenti })
  @IsEnum(AvisRessenti, { message: 'Choisis ton ressenti.' })
  ressenti: AvisRessenti;

  @ApiProperty({ enum: AvisCanal })
  @IsEnum(AvisCanal, { message: 'Choisis comment tu avais commandé.' })
  canal: AvisCanal;

  @ApiPropertyOptional({ description: 'Restaurant ; null = « Je ne sais pas »', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: "Ce store n'existe plus. Choisis-en un autre." })
  restaurant_id?: string | null;

  @ApiProperty({ minLength: COMMENTAIRE_MIN, maxLength: COMMENTAIRE_MAX })
  @Transform(rogner)
  @IsString({ message: MESSAGE_COMMENTAIRE })
  @Length(COMMENTAIRE_MIN, COMMENTAIRE_MAX, {
    message: (args) =>
      typeof args.value === 'string' && args.value.length > COMMENTAIRE_MAX
        ? 'Ton message dépasse 1 000 caractères.'
        : MESSAGE_COMMENTAIRE,
  })
  commentaire: string;

  @ApiProperty({ example: '+2250707000001' })
  @IsString({ message: 'Saisis un numéro mobile à 10 chiffres (07, 05 ou 01).' })
  @MaxLength(30, { message: 'Saisis un numéro mobile à 10 chiffres (07, 05 ou 01).' })
  telephone: string;

  @ApiPropertyOptional({ nullable: true, maxLength: PRENOM_MAX })
  @IsOptional()
  @Transform(rogner)
  @IsString({ message: 'Prénom invalide.' })
  @MaxLength(PRENOM_MAX, { message: 'Ton prénom ne doit pas dépasser 60 caractères.' })
  prenom?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean({ message: "L'accord de rappel est oui ou non." })
  accord_rappel?: boolean;

  @ApiPropertyOptional({ description: 'Code du QR code (marque-page, ticket, sac) ; toute autre valeur devient « site »' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  /** Champ piège : un humain ne le voit pas, un robot le remplit. */
  @ApiPropertyOptional({ description: 'Champ piège, toujours vide' })
  @Allow()
  site_web?: unknown;
}

/** Valeur du filtre Store : un restaurant, ou `aucun` (« Je ne sais pas »). */
export const STORE_AUCUN = 'aucun';
export const PERIODES = ['aujourdhui', '7j', '30j', 'tout'] as const;
export type Periode = (typeof PERIODES)[number];

export class ListeAvisQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;

  /** Moins de 2 caractères : ignorée. */
  @IsOptional() @IsString() @Transform(rogner) @MaxLength(100)
  recherche?: string;

  @IsOptional() @IsEnum(AvisRessenti)
  ressenti?: AvisRessenti;

  @IsOptional() @IsEnum(AvisStatut)
  statut?: AvisStatut;

  @IsOptional() @IsIn(['true', 'false'])
  en_retard?: 'true' | 'false';

  /** Forcé au restaurant du compte pour un point de vente (RestaurantQueryScopeGuard). */
  @IsOptional()
  @Matches(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|aucun)$/i)
  restaurantId?: string;

  @IsOptional() @IsIn(PERIODES)
  periode?: Periode;
}

export class CompteursAvisQueryDto {
  @IsOptional()
  @Matches(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|aucun)$/i)
  restaurantId?: string;
}

export class JournalAvisDto {
  @ApiProperty({ enum: ACTIONS_JOURNAL })
  @IsIn(ACTIONS_JOURNAL)
  action: ActionJournal;

  @ApiPropertyOptional({ enum: AvisResultat, nullable: true })
  @IsOptional()
  @IsEnum(AvisResultat)
  resultat?: AvisResultat | null;

  @ApiPropertyOptional({ maxLength: NOTE_MAX, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX + 200)
  note?: string | null;
}

export class StatutAvisDto {
  @ApiProperty({ enum: AvisStatut })
  @IsEnum(AvisStatut)
  statut: AvisStatut;

  @ApiPropertyOptional({ enum: AvisSolution, nullable: true })
  @IsOptional()
  @IsEnum(AvisSolution)
  solution?: AvisSolution | null;

  /** Statut lu à l'écran : l'écriture n'aboutit que s'il n'a pas changé entre-temps. */
  @ApiProperty({ enum: AvisStatut })
  @IsEnum(AvisStatut)
  statut_lu: AvisStatut;
}

export class CommandeAvisDto {
  @ApiProperty({ nullable: true, description: 'Commande concernée ; null décoche' })
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  order_id: string | null;
}

export class AgentAvisDto {
  @ApiProperty({ nullable: true, description: 'Agent ; null = Non assigné' })
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  agent_id: string | null;
}

export class TicketAvisDto {
  @ApiProperty()
  @IsUUID()
  categoryId: string;
}
