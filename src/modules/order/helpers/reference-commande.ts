/**
 * RÉFÉRENCE DE COMMANDE LIBRE (banc du 23/10).
 *
 * `ORD-AAMMJJ-NNNNN` tire cinq chiffres au hasard : 90 000 valeurs par jour.
 * Deux commandes du même jour tombent sur la même référence bien plus tôt
 * qu'on ne le croit (paradoxe des anniversaires : environ 12 % de risque dans
 * la journée à 150 commandes, plus de 25 % à 250). La création échouait alors
 * en 409 « reference existe déjà », et le client voyait sa commande refusée.
 *
 * La référence tirée est vérifiée avant la création et retirée tant qu'elle
 * existe déjà (8 essais). Une erreur de lecture ne bloque jamais la commande :
 * la référence tirée est gardée, comme avant.
 */
export const ESSAIS_REFERENCE_COMMANDE = 8;

export async function referenceCommandeLibre(
  generer: () => string,
  existe: (reference: string) => Promise<boolean>,
  essais = ESSAIS_REFERENCE_COMMANDE,
): Promise<string> {
  let reference = generer();
  for (let i = 1; i < essais; i++) {
    let prise: boolean;
    try {
      prise = await existe(reference);
    } catch {
      return reference;
    }
    if (!prise) return reference;
    reference = generer();
  }
  return reference;
}
