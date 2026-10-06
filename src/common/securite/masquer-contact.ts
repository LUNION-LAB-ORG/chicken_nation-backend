/**
 * Masquage des coordonnées d'un client.
 *
 * Certains rôles doivent voir les dossiers sans pouvoir en relever les
 * numéros ni les adresses : le marketing gère les cartes de la nation, il n'a
 * aucune raison de repartir avec le fichier de contacts.
 *
 * ⚠️ Le masquage se fait ICI, dans la réponse. Le cacher à l'écran ne
 * protégerait rien : la valeur partirait quand même, lisible dans l'onglet
 * Réseau du navigateur, et la copier demanderait trois clics.
 *
 * On garde une fin de numéro et le domaine de l'adresse : sans cela, deux
 * personnes différentes s'affichent à l'identique dans une liste, et plus
 * personne ne sait de qui on parle.
 */

/** « +2250140735992 » devient « +225•••••••92 ». */
export function masquerTelephone(valeur: string): string {
  const texte = valeur.trim();
  if (texte.length <= 4) return '•'.repeat(texte.length);
  const indicatif = texte.startsWith('+') ? texte.slice(0, 4) : '';
  const reste = texte.slice(indicatif.length);
  if (reste.length <= 2) return `${indicatif}${'•'.repeat(reste.length)}`;
  return `${indicatif}${'•'.repeat(reste.length - 2)}${reste.slice(-2)}`;
}

/** « monemailpro2007@gmail.com » devient « mon•••@gmail.com ». */
export function masquerEmail(valeur: string): string {
  const texte = valeur.trim();
  const arobase = texte.lastIndexOf('@');
  if (arobase <= 0) return '•'.repeat(Math.max(texte.length, 3));
  const nom = texte.slice(0, arobase);
  const domaine = texte.slice(arobase);
  const debut = nom.slice(0, Math.min(3, nom.length));
  return `${debut}${'•'.repeat(3)}${domaine}`;
}

/** Clés dont la valeur est une coordonnée à masquer. */
const CLES = new Set(['phone', 'email', 'telephone', 'whatsapp', 'phone_number']);

/**
 * Un objet SIMPLE, c'est-à-dire bon à reconstruire champ par champ.
 *
 * ⚠️ Le reste doit passer SANS ÊTRE TOUCHÉ. Recopier les champs d'un `Buffer`
 * (export de fichier), d'un flux, d'une `Date` ou d'un `Decimal` Prisma (les
 * montants) rendrait un objet nu qui a perdu ses méthodes : le fichier
 * arriverait illisible et le montant se sérialiserait en `{}`. Le masquage
 * couvre un contrôleur sur dix ; il ne doit rien casser sur les neuf autres.
 */
function estObjetSimple(valeur: unknown): boolean {
  if (valeur === null || typeof valeur !== 'object') return false;
  const prototype = Object.getPrototypeOf(valeur) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Parcourt une réponse et masque toute coordonnée, à n'importe quelle
 * profondeur.
 *
 * Récursif À DESSEIN : la liste des cartes imbrique le détenteur, la liste des
 * demandes imbrique le client, et la prochaine version en imbriquera autre
 * chose. Une liste de chemins à masquer aurait laissé fuiter le premier champ
 * ajouté sans y penser.
 */
export function masquerContacts<T>(valeur: T): T {
  if (Array.isArray(valeur)) {
    return valeur.map((v) => masquerContacts(v)) as unknown as T;
  }
  if (!estObjetSimple(valeur)) return valeur;
  const source = valeur as Record<string, unknown>;
  const copie: Record<string, unknown> = {};
  for (const [cle, v] of Object.entries(source)) {
    if (typeof v === 'string' && CLES.has(cle)) {
      copie[cle] = cle === 'email' ? masquerEmail(v) : masquerTelephone(v);
    } else {
      copie[cle] = masquerContacts(v);
    }
  }
  return copie as T;
}
