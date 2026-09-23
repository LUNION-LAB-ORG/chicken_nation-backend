import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProspectCallResult } from '@prisma/client';

/**
 * ACTIONS GROUPÉES sur une sélection de contacts.
 *
 * Le call center traite les contacts Glovo/Yango par paquets : qualifier
 * vingt appels un par un, puis rouvrir chaque fiche pour envoyer le coupon,
 * c'est quarante gestes pour une seule page de résultats.
 *
 * Le plafond n'est pas décoratif. Chaque coupon déclenche un SMS et plusieurs
 * écritures : sans borne, une sélection démesurée tiendrait la requête ouverte
 * jusqu'au délai d'expiration de la passerelle, et l'appelant ne saurait pas
 * ce qui est parti. Cent, c'est cinq pages pleines, largement au-delà de
 * l'usage réel.
 */
export const PLAFOND_SELECTION = 100;

export class BulkMarkCallDto {
  @ApiProperty({ type: [String], description: 'Identifiants des contacts visés' })
  @IsArray()
  @ArrayNotEmpty({ message: 'Aucun contact sélectionné' })
  @ArrayMaxSize(PLAFOND_SELECTION, {
    message: `Sélection limitée à ${PLAFOND_SELECTION} contacts à la fois`,
  })
  @IsString({ each: true })
  ids: string[];

  @ApiProperty({ enum: ProspectCallResult, example: ProspectCallResult.JOINT })
  @IsEnum(ProspectCallResult, {
    message: 'Résultat invalide (JOINT, NON_JOIGNABLE ou REFUS)',
  })
  result: ProspectCallResult;

  @ApiPropertyOptional({ description: "Note libre, appliquée à tous les appels du lot" })
  @IsOptional()
  @IsString()
  note?: string;
}

export class BulkCouponDto {
  @ApiProperty({ type: [String], description: 'Identifiants des contacts visés' })
  @IsArray()
  @ArrayNotEmpty({ message: 'Aucun contact sélectionné' })
  @ArrayMaxSize(PLAFOND_SELECTION, {
    message: `Sélection limitée à ${PLAFOND_SELECTION} contacts à la fois`,
  })
  @IsString({ each: true })
  ids: string[];
}

/** Un contact qui n'a pas pu être traité, et pourquoi. */
export interface EchecGroupe {
  id: string;
  nom: string | null;
  motif: string;
}

/**
 * Compte rendu d'une action groupée.
 *
 * Une action groupée réussit rarement en bloc : un contact déjà pourvu d'un
 * coupon, un autre pas encore joint, un troisième hors périmètre. Répondre
 * « c'est fait » serait faux, lever une exception au premier refus perdrait
 * les dix-neuf autres. On traite tout, et on rend compte de chacun.
 */
export interface ResultatGroupe {
  demandes: number;
  reussis: number;
  /** Coupons créés dont le SMS n'est pas parti (le code existe, à communiquer). */
  sansSms?: number;
  echecs: EchecGroupe[];
}
