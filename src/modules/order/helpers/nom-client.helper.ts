/**
 * Nom inscrit sur une commande (`Order.fullname`), celui que lisent la caisse,
 * le livreur, le centre d'appels et Turbo (`nomComplet` du destinataire).
 *
 * ⚠️ CORRIGÉ (02/10). Les deux chemins de création reprenaient le profil par
 * `${first_name} ${last_name}`. Un client qui n'a pas encore donné son nom
 * (compte créé à la vérification du code, sans prénom ni nom) passait ainsi
 * commande au nom de « null null ». Le site en produisait : son étape « nom »
 * vient après la pose de la session, et un rechargement la sautait ; il
 * envoyait alors un nom vide, et c'est ce repli du serveur qui écrivait
 * « null null ».
 *
 * Garde-fou en plus : un nom reçu, ou un profil, recollé ailleurs avec la même
 * erreur (`${null}` donne « null ») ne doit pas finir sur la commande. Les
 * morceaux « null » et « undefined » sont donc ignorés.
 *
 * Ordre retenu :
 *  1. le nom saisi pour la commande, s'il reste quelque chose ;
 *  2. le prénom et le nom du profil, ceux qui existent ;
 *  3. le téléphone de la commande, qui identifie toujours le client.
 */
export function nomSurLaCommande(
  saisi: string | null | undefined,
  client: { first_name?: string | null; last_name?: string | null },
  telephone: string | null | undefined,
): string {
  const nomSaisi = sansMorceauxVides(saisi);
  if (nomSaisi) return nomSaisi;

  const nomProfil = [client.first_name, client.last_name]
    .map(sansMorceauxVides)
    .filter(Boolean)
    .join(' ');
  if (nomProfil) return nomProfil;

  return telephone?.trim() ?? '';
}

/** Valeur vide recollée dans une chaîne : `${null}` donne « null ». */
const MORCEAU_VIDE = /^(null|undefined)$/i;

/** Le nom sans ses espaces en trop ni ses morceaux « null » / « undefined ». */
function sansMorceauxVides(nom: string | null | undefined): string {
  return (nom ?? '')
    .split(/\s+/)
    .filter((morceau) => morceau !== '' && !MORCEAU_VIDE.test(morceau))
    .join(' ');
}
