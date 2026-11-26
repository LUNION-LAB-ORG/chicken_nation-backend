/**
 * NOTE D'UNE COMMANDE (26/11). Fonction pure.
 *
 * Les commandes de l'appli et du site (`createv2`) n'enregistraient pas la
 * note : seules celles saisies au back-office la gardaient. Depuis le 26/11,
 * l'appli y écrit pour qui est la commande quand le client commande pour une
 * autre personne (« Commande pour Awa Koné, 07 07 07 07 07 ») : le
 * restaurant, le centre d'appels et le reçu la lisent déjà.
 *
 * La note reste un texte libre court : espaces resserrés, 255 caractères au
 * plus, rien si elle est vide.
 */
export const NOTE_COMMANDE_MAX = 255;

export function noteDeCommande(valeur: unknown): string | undefined {
  if (typeof valeur !== 'string') return undefined;
  const note = valeur.replace(/\s+/g, ' ').trim();
  if (!note) return undefined;
  return note.length > NOTE_COMMANDE_MAX ? note.slice(0, NOTE_COMMANDE_MAX).trimEnd() : note;
}
