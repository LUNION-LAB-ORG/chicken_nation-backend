/**
 * STOCKAGE DE SUBSTITUTION, POUR LES BANCS DE TEST (26/11).
 *
 * `AWS_S3_ENDPOINT` permet à un banc local de ranger les fichiers (images,
 * notes vocales) sur le poste au lieu d'Amazon. Seule une adresse DU POSTE
 * (`127.0.0.1` ou `localhost`) est acceptée : une valeur vide, absente ou
 * pointant ailleurs est ignorée, et le serveur parle à Amazon comme avant.
 * La production ne peut donc pas être détournée par cette variable.
 */
const ADRESSE_DU_POSTE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/;

export function adresseStockageLocal(valeur: string | undefined | null): string | null {
  const adresse = (valeur ?? '').trim();
  if (!ADRESSE_DU_POSTE.test(adresse)) return null;
  return adresse.replace(/\/$/, '');
}
