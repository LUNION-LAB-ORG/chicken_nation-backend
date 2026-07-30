import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

/** Une part d'un PAIEMENT PARTAGÉ : le montant réglé via un moyen donné. */
export class EncaissementItemDto {
  @ApiProperty({ description: 'Code fermé du moyen (cash, orange-ci, mtn-ci, moov-ci, wave, card)', example: 'wave' })
  @IsOptional()
  @IsString()
  moyen_paiement?: string;

  @ApiProperty({ description: 'Montant réglé via ce moyen', example: 1200 })
  @IsOptional()
  @IsNumber()
  montant?: number;
}

/**
 * Validation d'une livraison par PIN client.
 * Le client fournit au livreur un code à 4 chiffres reçu par push/SMS.
 */
export class ConfirmDeliveryDto {
  @ApiProperty({ description: 'PIN 4 chiffres fourni par le client', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'Le PIN doit contenir exactement 4 chiffres' })
  pin: string;

  /**
   * ENCAISSEMENT À LA LIVRAISON (commande non payée) : moyen de paiement
   * utilisé par le client, choisi par le livreur dans la liste FERMÉE du
   * référentiel caissière : cash | orange-ci | mtn-ci | moov-ci | wave | card.
   * Le paiement est enregistré EN ATTENTE — le backoffice le confirme, ce qui
   * termine la commande. Absent/inconnu → espèces (lecture tolérante).
   */
  @ApiProperty({
    required: false,
    description: "Moyen de paiement encaissé (cash, orange-ci, mtn-ci, moov-ci, wave, card)",
    example: 'orange-ci',
  })
  @IsOptional()
  @IsString()
  moyen_paiement?: string;

  @ApiProperty({
    required: false,
    description: 'Montant réellement encaissé (défaut : montant TTC de la commande)',
    example: 12500,
  })
  @IsOptional()
  @IsNumber()
  montant_encaisse?: number;

  /**
   * PAIEMENT PARTAGÉ : le client règle en plusieurs moyens (une partie Wave,
   * une partie Orange…). Une entrée PAR MOYEN, montants agrégés côté app.
   * Prioritaire sur `moyen_paiement`/`montant_encaisse` quand présent.
   */
  @ApiProperty({
    required: false,
    type: [EncaissementItemDto],
    description: 'Paiement partagé : une entrée {moyen_paiement, montant} par moyen',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EncaissementItemDto)
  encaissements?: EncaissementItemDto[];
}
