/**
 * Distingue un identifiant technique d'une référence lisible.
 *
 * ⚠️ Remplace une heuristique de LONGUEUR (`valeur.length > 10`) qui était
 * fausse dès que la référence dépassait dix caractères. Or une référence de
 * commande vaut `ORD-260902-12345`, soit seize caractères : elle était donc
 * systématiquement prise pour un identifiant, et passée telle quelle à une
 * colonne UUID, ce qui ne peut que casser. Autrement dit, la recherche par
 * référence de commande n'a jamais fonctionné.
 *
 * Le test porte désormais sur la FORME, ce qui accepte une référence de
 * n'importe quelle longueur.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const estUuid = (valeur: string): boolean => UUID.test(valeur);

/**
 * Construit la condition Prisma qui va bien selon ce qu'on a reçu.
 * Un identifiant technique cherche sur `id`, tout le reste sur `reference`.
 */
export const parIdentifiantOuReference = (valeur: string) =>
  estUuid(valeur) ? { id: valeur } : { reference: valeur };
