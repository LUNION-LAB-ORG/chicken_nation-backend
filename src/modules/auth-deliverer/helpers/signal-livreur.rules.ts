/**
 * SIGNE DE VIE ET PROTOCOLE DE L'APPLI LIVREUR, relevés à chaque requête
 * authentifiée (JwtDelivererStrategy).
 *
 *  - `dernier_signal_at` : écrit au plus une fois par minute (une écriture en
 *    base par requête serait du gaspillage). Sert au filet « hors service sans
 *    signal » : un livreur qui laisse expirer une offre sans aucun signal
 *    depuis longtemps passe hors service ;
 *  - `protocole_appli` : en-tête `x-deli-protocole` (2 = appli qui lit sa
 *    pause au serveur ; absent = ancienne appli, noté 1). Réécrit dès qu'il
 *    change.
 */
export const ENTETE_PROTOCOLE_APPLI = 'x-deli-protocole';

/** Protocole d'une requête sans en-tête : l'ancienne appli. */
export const PROTOCOLE_ANCIENNE_APPLI = 1;

export const INTERVALLE_SIGNAL_MS = 60_000;

/** Protocole lu dans l'en-tête ; absent ou illisible : ancienne appli. */
export function lireProtocoleAppli(entete: string | string[] | undefined): number {
  const brut = Array.isArray(entete) ? entete[0] : entete;
  const n = Number.parseInt(String(brut ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : PROTOCOLE_ANCIENNE_APPLI;
}

export interface SignalConnu {
  dernier_signal_at: Date | null;
  protocole_appli: number | null;
}

/** Ce qu'il faut écrire sur le livreur pour cette requête, ou `null` si rien. */
export function majSignalLivreur(
  connu: SignalConnu,
  protocole: number,
  maintenant: Date,
): { dernier_signal_at: Date; protocole_appli: number } | null {
  const signalPerime =
    connu.dernier_signal_at === null ||
    maintenant.getTime() - connu.dernier_signal_at.getTime() >= INTERVALLE_SIGNAL_MS;
  const protocoleChange = connu.protocole_appli !== protocole;
  if (!signalPerime && !protocoleChange) return null;
  return { dernier_signal_at: maintenant, protocole_appli: protocole };
}
