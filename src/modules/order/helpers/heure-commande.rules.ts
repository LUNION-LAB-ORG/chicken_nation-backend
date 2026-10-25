/**
 * Heure d'une commande (`Order.time`), « HH:MM », heure d'Abidjan.
 *
 * La Côte d'Ivoire vit à UTC+0 toute l'année, sans heure d'été : l'heure UTC
 * est l'heure de l'horloge murale. C'est ce que relisent `momentSouhaite`
 * (préparation, « Plus tard · 20h00 ») et `heureProgrammee` (planification).
 */
export function heureAbidjan(instant: Date): string {
  const deux = (n: number) => String(n).padStart(2, '0');
  return `${deux(instant.getUTCHours())}:${deux(instant.getUTCMinutes())}`;
}

/**
 * Heure à écrire à la création : celle saisie, sinon l'heure de création.
 *
 * Une commande sans heure recevait « 10:00 ». Passée à 15 h, elle se
 * retrouvait à 10 h ; passée à 7 h 30, elle devenait programmée pour 10 h et
 * sa préparation était refusée avant 9 h. Aucun lecteur ne se servait de
 * « 10:00 » comme repère. L'application écrit déjà l'heure de création
 * (`createv2`) : les deux chemins disent maintenant la même chose.
 */
export function heureDeLaCommande(saisie: string | null | undefined, creeLe: Date): string {
  const heure = typeof saisie === 'string' ? saisie.trim() : '';
  return heure || heureAbidjan(creeLe);
}
