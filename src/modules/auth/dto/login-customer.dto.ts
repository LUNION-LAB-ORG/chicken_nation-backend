import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { MESSAGE_NUMERO_INVALIDE } from '../helpers/envois-otp.helper';

/**
 * Forme d'un numéro saisi : `+` facultatif, puis 8 à 20 chiffres, espaces,
 * points, tirets ou parenthèses. Le contrôle complet (indicatif, longueur) est
 * fait par `normaliserTelephoneClient` dans le service.
 *
 * Un seul validateur par champ : la réponse 400 de ValidationPipe liste chaque
 * contrainte violée, et l'application affiche la liste telle quelle (le même
 * message répété quatre fois pour un champ absent).
 */
export const FORME_TELEPHONE = /^\+?[\d\s.\-()]{8,20}$/;

/** Retire les espaces autour ; une valeur qui n'est pas du texte est laissée à la validation. */
export const sansEspacesAutour = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class LoginCustomerDto {
  // PHONE
  @ApiProperty({
    description: 'numéro de téléphone du client, avec indicatif',
    example: '+2250777777777',
    required: true,
    maxLength: 20,
  })
  // Refuse aussi ce qui n'est pas du texte et le champ absent.
  @Matches(FORME_TELEPHONE, { message: MESSAGE_NUMERO_INVALIDE })
  @Transform(sansEspacesAutour)
  phone: string;
}
