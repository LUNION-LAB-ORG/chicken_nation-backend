import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

/** Champ vide envoyé par un formulaire : traité comme absent. */
const videEnAbsent = ({ value }: { value: unknown }) => (value === '' ? undefined : value);

/**
 * Restaurant où chercher le code de retrait. Ignoré pour un compte de
 * restaurant (caissière, manager) : c'est toujours le sien, et un autre est
 * refusé. Un compte du siège sans restaurant cherche dans tout le réseau.
 */
export class QueryPickupCodeDto {
  @ApiPropertyOptional({
    description: 'Restaurant où chercher le code (compte du siège). Sans lui : tous les restaurants.',
  })
  @Transform(videEnAbsent)
  @IsOptional()
  @IsUUID(undefined, { message: 'Restaurant inconnu.' })
  restaurant_id?: string;
}

/**
 * Payload de validation d'une récupération au restaurant par la caissière.
 *
 * Le livreur dicte son code 3 chiffres (donné à la création de la Course),
 * la caissière le saisit dans le backoffice → on déclenche en cascade :
 *   Course AT_RESTAURANT/ACCEPTED → IN_DELIVERY
 *   Orders READY → PICKED_UP
 *   Timestamps à jour partout
 *
 * La caisse Sunmi n'envoie que `pickup_code` : le restaurant est alors celui
 * du compte connecté.
 */
export class ValidatePickupDto extends QueryPickupCodeDto {
  @ApiProperty({
    description: 'Code de retrait à 3 chiffres donné par le livreur',
    example: '421',
  })
  @IsNotEmpty()
  @IsString()
  @Length(3, 3, { message: 'Le code retrait doit comporter exactement 3 chiffres' })
  @Matches(/^\d{3}$/, { message: 'Le code retrait doit être composé de 3 chiffres' })
  pickup_code: string;
}
