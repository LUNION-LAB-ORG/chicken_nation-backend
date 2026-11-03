/**
 * Codes de parrainage lisibles : `CN-` suivi du prénom du parrain (03/11).
 *
 * L'ancien code (`CN` + 6 caractères tirés au hasard, ex. `CNABC23`) ne disait
 * pas à qui il appartenait. Le code porte désormais le prénom, sinon le nom :
 * `CN-AWA`, `CN-KOUADIO`. Quand il est pris, le nom de famille, puis le prénom
 * suivi d'un numéro (`CN-AWA2`). Le parrain se retrouve à la lecture du code.
 *
 * ⚠️ Le préfixe `CN-` est partagé avec la Carte de la Nation (`CN-BA123`) et
 * les codes de coupon du CRM (`CN-` + 6 caractères). Un code de parrainage ne
 * prend jamais la forme d'un numéro de carte, et le service vérifie qu'aucun
 * code promo ne le porte déjà.
 */

export const PREFIXE_CODE = 'CN-';

/** Longueur maximale de la partie qui suit `CN-`. */
const LONGUEUR_MAX = 16;

/** Forme d'un numéro de Carte de la Nation : jamais un code de parrainage. */
const FORME_CARTE = /^CN-[A-Z]{2}\d{3}$/;

/** Forme d'un code choisi au backoffice. */
const FORME_CODE = new RegExp(`^CN-[A-Z0-9]{2,${LONGUEUR_MAX}}$`);

/** Majuscules sans accents, lettres et chiffres seulement. */
export function alphanumerique(texte: string | null | undefined): string {
  return (texte ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Premier mot d'un nom, en lettres seules : « Marie Claire » donne MARIE, « N'Guessan » NGUESSAN. */
function mot(texte: string | null | undefined): string {
  const premier = (texte ?? '').trim().split(/\s+/)[0] ?? '';
  return alphanumerique(premier).replace(/[0-9]/g, '').slice(0, 12);
}

/**
 * Codes proposés, dans l'ordre : prénom, nom, puis prénom numéroté. Sans nom
 * exploitable : CN-CLIENT. Jamais de chiffres du téléphone : le parrain diffuse
 * son code, il ne doit pas diffuser une partie de son numéro.
 */
export function* codesPossibles(client: {
  first_name?: string | null;
  last_name?: string | null;
}): Generator<string> {
  const prenom = mot(client.first_name);
  const nom = mot(client.last_name);
  const bases = [prenom, nom].filter((b) => b.length >= 2);
  if (bases.length === 0) bases.push('CLIENT');

  for (const base of bases) yield `${PREFIXE_CODE}${base}`;
  for (let n = 2; n < 10000; n++) {
    const code = `${PREFIXE_CODE}${bases[0]}${n}`;
    if (!FORME_CARTE.test(code)) yield code;
  }
}

/**
 * Codes à chercher pour une saisie du client : « cn-awa », « CN AWA », « CNAWA »
 * et « awa » désignent tous `CN-AWA`. `ancien` est la saisie telle quelle, pour
 * les codes d'avant le 03/11 (`CNABC23`), qui restent valables.
 */
export function lireSaisie(saisie: string | null | undefined): {
  nouveaux: string[];
  ancien: string;
} {
  const brut = alphanumerique(saisie);
  // « CN- » seul n'est pas un code.
  if (!brut || brut === 'CN') return { nouveaux: [], ancien: '' };
  const nouveaux = [`${PREFIXE_CODE}${brut}`];
  // Le préfixe tapé sans tiret : « CNAWA ». Un prénom qui commence par CN
  // reste trouvable par la forme complète ci-dessus.
  if (brut.startsWith('CN') && brut.length > 2) nouveaux.unshift(`${PREFIXE_CODE}${brut.slice(2)}`);
  return { nouveaux, ancien: brut };
}

/**
 * Code choisi au backoffice, remis en forme (`awa` donne `CN-AWA`). Renvoie
 * un message d'erreur à afficher quand il ne convient pas.
 */
export function lireCodeChoisi(saisie: string): { code: string } | { erreur: string } {
  const { nouveaux } = lireSaisie(saisie);
  const code = nouveaux[0];
  if (!code || !FORME_CODE.test(code)) {
    return {
      erreur: `Le code s'écrit CN- suivi de 2 à ${LONGUEUR_MAX} lettres ou chiffres, par exemple CN-AWA.`,
    };
  }
  if (!/[A-Z]/.test(code.slice(PREFIXE_CODE.length))) {
    return { erreur: 'Le code doit contenir au moins une lettre, par exemple CN-AWA.' };
  }
  if (FORME_CARTE.test(code)) {
    return { erreur: 'Ce code a la forme d’un numéro de Carte de la Nation. Choisissez-en un autre.' };
  }
  return { code };
}

/** Le code a-t-il la forme d'un numéro de carte ? */
export function formeDeCarte(code: string): boolean {
  return FORME_CARTE.test(code);
}
