/**
 * Retire d'une commande tout ce qui permet d'envoyer une notification à un
 * téléphone.
 *
 * ⚠️ Le serveur envoie ses notifications Expo sans jeton d'accès : un jeton
 * `ExponentPushToken[…]` suffit pour pousser n'importe quel message sur le
 * téléphone du client, au nom de Chicken Nation. Or les commandes partent vers
 * la salle du restaurant (caisse, cuisine, gérant) et vers tous les comptes du
 * back office. Elles emportaient `customer.notification_settings` complet.
 *
 * Personne ne lit ces champs dans une commande : l'application client lit ses
 * réglages depuis son profil, la caisse et le back office ne les lisent nulle
 * part. On les retire donc partout, à toute profondeur, y compris le jeton
 * d'un livreur ou d'un membre du personnel qu'un `include` trop large aurait
 * embarqué.
 *
 * Les dates, les décimaux et toute autre instance sont rendus tels quels : on
 * ne parcourt que les objets simples et les tableaux, qui sont ce que Prisma
 * renvoie.
 */
export const CLES_IDENTIFIANTS_PUSH: ReadonlySet<string> = new Set([
  'notification_settings',
  'expo_push_token',
  'expo_push_token_revoked',
  'expo_push_token_revoked_at',
  'onesignal_id',
  'onesignal_subscription_id',
]);

/**
 * Garde-fou contre une structure anormalement profonde. Une commande avec sa
 * livraison, sa course et son livreur tient en cinq niveaux.
 */
const PROFONDEUR_MAX = 12;

function estObjetSimple(valeur: unknown): valeur is Record<string, unknown> {
  if (valeur === null || typeof valeur !== 'object') return false;
  const prototype = Object.getPrototypeOf(valeur);
  return prototype === Object.prototype || prototype === null;
}

function nettoyer(valeur: unknown, profondeur: number): unknown {
  if (profondeur > PROFONDEUR_MAX) return valeur;
  if (Array.isArray(valeur)) {
    return valeur.map((element) => nettoyer(element, profondeur + 1));
  }
  if (!estObjetSimple(valeur)) return valeur;

  const copie: Record<string, unknown> = {};
  for (const [cle, contenu] of Object.entries(valeur)) {
    if (CLES_IDENTIFIANTS_PUSH.has(cle)) continue;
    copie[cle] = nettoyer(contenu, profondeur + 1);
  }
  return copie;
}

/**
 * Copie de `valeur` sans aucun identifiant de notification. L'original n'est
 * pas modifié : l'appelant peut encore y lire le jeton pour son propre envoi.
 */
export function sansIdentifiantsPush<T>(valeur: T): T {
  return nettoyer(valeur, 0) as T;
}
