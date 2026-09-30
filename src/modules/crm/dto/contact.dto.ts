import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const ETATS_COUPON = ['AUCUN', 'ACTIF', 'UTILISE', 'EXPIRE'] as const;
export type EtatCoupon = (typeof ETATS_COUPON)[number];

export const SEGMENTS_CRM = ['JAMAIS_COMMANDE', 'INACTIF', 'GLOVO', 'YANGO'] as const;

/**
 * État du COMPTE CLIENT, repris de l'ancienne page Clients.
 *
 * ⚠️ À ne pas confondre avec le PUBLIC (`segment`), qui dit par où le contact
 * est entré et ne bouge plus. Celui-ci décrit le compte applicatif tel qu'il
 * est aujourd'hui. Les deux se combinent : un contact capté sur Glovo peut
 * très bien avoir l'application installée.
 *
 * Ces valeurs n'ont de sens que pour un contact RATTACHÉ à un compte : un
 * numéro relevé en caisse sans compte ne correspond à aucune d'elles, et le
 * filtre de relation l'écarte de lui-même.
 */
export const COMPTES_CLIENT = [
  'avec_app',
  'sans_app',
  'a_commande',
  'jamais_commande',
  'profil_incomplet',
] as const;

export const TRIS_CONTACTS = [
  'entree_desc',
  'inscription_desc',
  'inscription_asc',
  'appel_desc',
  'appel_asc',
  'tentatives_desc',
  'derniere_commande_asc',
  'derniere_commande_desc',
] as const;

/** Filtres combinables de la liste (cahier §4.2), partagés avec l'export. */
export class QueryCrmContactDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Nom, prénom, e-mail ou téléphone' })
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Public : inscrits sans commande, inactifs…', enum: SEGMENTS_CRM })
  @IsOptional() @IsIn(SEGMENTS_CRM)
  segment?: (typeof SEGMENTS_CRM)[number];

  @ApiPropertyOptional({ enum: COMPTES_CLIENT, description: "État du compte client (ancienne page Clients)" })
  @IsOptional() @IsIn(COMPTES_CLIENT)
  compte?: (typeof COMPTES_CLIENT)[number];

  @ApiPropertyOptional({ description: 'Statuts séparés par des virgules. Par défaut : tous sauf CONVERTI' })
  @IsOptional() @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "Identifiant d'agent, ou « none » pour les non assignés" })
  @IsOptional() @IsString()
  agent_id?: string;

  @ApiPropertyOptional({ description: 'Identifiant de campagne, ou « none » pour hors campagne' })
  @IsOptional() @IsString()
  campaign_id?: string;

  @IsOptional() @IsUUID()
  call_status_id?: string;

  @IsOptional() @IsUUID()
  loss_reason_id?: string;

  @IsOptional() @IsIn(ETATS_COUPON)
  coupon?: EtatCoupon;

  @IsOptional() @IsDateString()
  registered_from?: string;

  @IsOptional() @IsDateString()
  registered_to?: string;

  @IsOptional() @IsDateString()
  last_call_from?: string;

  @IsOptional() @IsDateString()
  last_call_to?: string;

  @ApiPropertyOptional({ description: 'Restaurant où le contact a été capté (Glovo/Yango)' })
  @IsOptional() @IsUUID()
  restaurant_id?: string;

  @ApiPropertyOptional({ description: 'Captés depuis le (même capture que le restaurant)' })
  @IsOptional() @IsDateString()
  captured_from?: string;

  @IsOptional() @IsDateString()
  captured_to?: string;

  @ApiPropertyOptional({ description: '« true » : jamais appelés' })
  @IsOptional() @IsIn(['true', 'false'])
  never_called?: string;

  @ApiPropertyOptional({ description: '« true » : au moins un paiement en ligne abandonné' })
  @IsOptional() @IsIn(['true', 'false'])
  abandoned?: string;

  @IsOptional() @IsIn(TRIS_CONTACTS)
  sort?: (typeof TRIS_CONTACTS)[number];
}

export class ExportCrmContactDto extends QueryCrmContactDto {
  @IsOptional() @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';
}

export class AssignContactsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(2000) @IsUUID('all', { each: true })
  contact_ids: string[];

  @ApiPropertyOptional({ description: 'null pour retirer l’agent' })
  @ValidateIf((_, v) => v !== null) @IsUUID()
  agent_id: string | null;
}

export class RecordCallDto {
  @IsUUID()
  call_status_id: string;

  @IsOptional() @IsUUID()
  loss_reason_id?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  comment?: string;

  @IsOptional() @IsDateString()
  callback_at?: string;
}

export class SendCouponDto {
  @IsOptional() @IsUUID()
  offer_id?: string;
}

export class QueryExportsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}

/**
 * Nommer un contact qui n'a pas de nom.
 *
 * ⚠️ Prénom et nom sont demandés SÉPARÉMENT, jamais découpés d'une saisie
 * libre. Le prénom personnalise les messages de coupon : une découpe qui se
 * trompe d'ordre ferait dire « Bonjour Koné ! » à Salif Koné, à chaque envoi
 * et pour toujours. Deux champs coûtent une seconde à l'agent et suppriment
 * la question.
 */
export class RenommerContactDto {
  @ApiProperty({ description: 'Prénom, celui qui servira dans les messages', example: 'Salif' })
  @IsString()
  @IsNotEmpty({ message: 'Le prénom est obligatoire' })
  @MaxLength(60)
  prenom: string;

  @ApiPropertyOptional({ description: 'Nom de famille', example: 'Koné' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nom?: string;
}
