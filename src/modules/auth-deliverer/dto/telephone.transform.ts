import type { TransformFnParams } from 'class-transformer';

/**
 * Normalisation du téléphone saisi, commune aux DTO des livreurs : `+` puis
 * les chiffres. C'est la forme sous laquelle le compte est enregistré et sous
 * laquelle les codes sont envoyés : l'envoi, la vérification du code et la
 * connexion retrouvent donc la même ligne, quelle que soit la graphie saisie.
 *
 * Une valeur qui n'est pas du texte est laissée telle quelle et une chaîne
 * vide reste vide : la validation (@IsNotEmpty, @MaxLength) les refuse en 400,
 * au lieu d'une erreur 500 (que l'appli relancerait trois fois) ou d'un
 * numéro réduit à « + ».
 */
export function normaliserTelephoneSaisi({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') return value;
  const phone = value.trim();
  if (!phone) return phone;
  return (phone.startsWith('+') ? phone : `+${phone}`).replace(/[^\d+]/g, '');
}
