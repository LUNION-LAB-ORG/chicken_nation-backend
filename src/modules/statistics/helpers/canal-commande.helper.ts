import { OrderChannel } from '@prisma/client';

/**
 * Canal de vente d'une commande, tel que les statistiques le comptent.
 *
 * Le champ `channel` n'existe que depuis le 02/10/2026 (commande en ligne sur
 * le site). Seul le site en tire son canal : les commandes antérieures et
 * celles de HubRise ont `channel` vide, et les autres canaux se lisent déjà
 * avec `auto`. Règle historique gardée pour tout le reste : `auto` vrai =
 * application, faux = centre d'appels (caisse comprise).
 *
 * Même règle que l'export Excel des commandes (« Site web », « Appli »,
 * « Téléphone ») : l'écran et l'export ne se contredisent pas. Seule
 * différence : la vente au comptoir (channel RESTAURANT, `auto` faux), que
 * l'export nomme « Restaurant », reste comptée ici avec le centre d'appels,
 * comme avant l'ajout du canal.
 */
export type CanalStats = 'APP' | 'WEB' | 'CALL_CENTER';

/** Canal préféré d'un client : MIXED si plusieurs canaux sont à égalité en tête. */
export type CanalPrefere = CanalStats | 'MIXED';

/** Ce qu'il faut lire d'une commande (ou d'un groupe Prisma) pour son canal. */
export interface CommandeCanal {
  auto: boolean | null;
  channel?: OrderChannel | null;
}

/** Compteurs par canal, sous les noms de champ des réponses de l'API. */
export interface CompteParCanal {
  app: number;
  web: number;
  callCenter: number;
}

/** Champ de la réponse qui porte chaque canal. */
export const CLE_CANAL: Record<CanalStats, keyof CompteParCanal> = {
  APP: 'app',
  WEB: 'web',
  CALL_CENTER: 'callCenter',
};

export function canalDeCommande(commande: CommandeCanal): CanalStats {
  if (commande.channel === OrderChannel.WEB) return 'WEB';
  return commande.auto === true ? 'APP' : 'CALL_CENTER';
}

export function compteParCanalVide(): CompteParCanal {
  return { app: 0, web: 0, callCenter: 0 };
}

/** Ajoute `n` (1 par défaut) au compteur du canal de la commande. */
export function ajouterAuCanal(
  compte: CompteParCanal,
  commande: CommandeCanal,
  n = 1,
): void {
  compte[CLE_CANAL[canalDeCommande(commande)]] += n;
}

/**
 * Canal où le client a passé strictement le plus de commandes. Égalité en
 * tête, ou aucune commande : MIXED. Sans commande du site, le résultat est le
 * même qu'avec l'ancienne comparaison App / Call Center.
 */
export function canalPrefere(compte: CompteParCanal): CanalPrefere {
  const entrees: [CanalStats, number][] = [
    ['APP', compte.app],
    ['WEB', compte.web],
    ['CALL_CENTER', compte.callCenter],
  ];
  const max = Math.max(...entrees.map(([, n]) => n));
  const enTete = entrees.filter(([, n]) => n === max);
  return enTete.length === 1 ? enTete[0][0] : 'MIXED';
}
