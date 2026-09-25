/**
 * Compteur d'échecs de connexion du personnel, PAR EMAIL.
 *
 * La limite par adresse IP (ThrottlerGuard sur POST /auth/login) ne suffit
 * pas : `trust proxy` rend l'IP falsifiable par X-Forwarded-For, et une caisse
 * partage son adresse avec ses collègues. On compte donc aussi les échecs par
 * email, qu'il existe ou non (sinon le verrou trahirait les comptes réels).
 *
 * Même politique que la vérification OTP des clients : au bout de
 * MAX_ECHECS_CONNEXION échecs dans une fenêtre de FENETRE_ECHECS_CONNEXION_MS,
 * l'email est verrouillé pendant DUREE_BLOCAGE_CONNEXION_MS, même avec le bon
 * mot de passe. Une connexion réussie remet le compteur à zéro.
 *
 * Fonctions pures : l'état vit dans le cache (Redis), le service ne fait que
 * le lire, appeler ces fonctions et réécrire.
 */

export const MAX_ECHECS_CONNEXION = 5;
export const FENETRE_ECHECS_CONNEXION_MS = 15 * 60 * 1000; // 15 min
export const DUREE_BLOCAGE_CONNEXION_MS = 15 * 60 * 1000; // 15 min

const PREFIXE_CLE = 'connexion-echecs:';

export const MESSAGE_IDENTIFIANTS_INCORRECTS = 'Email ou mot de passe incorrect.';

// Réponse de ThrottlerGuard (limite par IP, bloc d'une minute).
export const MESSAGE_TROP_DE_CONNEXIONS =
  'Trop de tentatives de connexion. Réessayez dans une minute.';

export interface EtatEchecsConnexion {
  /** Nombre d'échecs dans la fenêtre en cours. */
  echecs: number;
  /** Début de la fenêtre (horodatage en millisecondes). */
  depuis: number;
  /** Fin du verrou (horodatage en millisecondes), `null` si pas verrouillé. */
  bloqueJusqua: number | null;
}

/** Clé de cache : l'email sans espaces ni majuscules, pour qu'une variante de casse ne remette pas le compteur à zéro. */
export function cleEchecsConnexion(email: string): string {
  return `${PREFIXE_CLE}${String(email ?? '').trim().toLowerCase()}`;
}

/** Relit une valeur du cache ; toute forme inattendue vaut « aucun échec ». */
export function lireEtatEchecs(valeur: unknown): EtatEchecsConnexion | null {
  if (!valeur || typeof valeur !== 'object') return null;
  const { echecs, depuis, bloqueJusqua } = valeur as Record<string, unknown>;
  if (typeof echecs !== 'number' || !Number.isFinite(echecs) || echecs < 0) return null;
  if (typeof depuis !== 'number' || !Number.isFinite(depuis)) return null;
  const fin =
    typeof bloqueJusqua === 'number' && Number.isFinite(bloqueJusqua) ? bloqueJusqua : null;
  return { echecs, depuis, bloqueJusqua: fin };
}

/** Minutes de verrou restantes (arrondies au-dessus), 0 si l'email n'est pas verrouillé. */
export function minutesRestantesBlocage(
  etat: EtatEchecsConnexion | null,
  maintenant: number,
): number {
  if (!etat?.bloqueJusqua) return 0;
  const resteMs = etat.bloqueJusqua - maintenant;
  return resteMs > 0 ? Math.ceil(resteMs / 60_000) : 0;
}

/**
 * Nouvel état après un échec, avec la durée de vie à donner à la clé et les
 * minutes de verrou si cet échec atteint le plafond (0 sinon).
 */
export function etatApresEchec(
  etat: EtatEchecsConnexion | null,
  maintenant: number,
): { etat: EtatEchecsConnexion; ttlMs: number; minutesBlocage: number } {
  // Fenêtre écoulée ou verrou levé : on repart d'une fenêtre propre.
  const repartir =
    !etat ||
    maintenant - etat.depuis > FENETRE_ECHECS_CONNEXION_MS ||
    (etat.bloqueJusqua !== null && etat.bloqueJusqua <= maintenant);

  const echecs = repartir ? 1 : etat.echecs + 1;
  const depuis = repartir ? maintenant : etat.depuis;
  const bloqueJusqua =
    echecs >= MAX_ECHECS_CONNEXION ? maintenant + DUREE_BLOCAGE_CONNEXION_MS : null;

  const finMs = bloqueJusqua ?? depuis + FENETRE_ECHECS_CONNEXION_MS;
  const ttlMs = Math.max(finMs - maintenant, 1000);

  return {
    etat: { echecs, depuis, bloqueJusqua },
    ttlMs,
    minutesBlocage: minutesRestantesBlocage({ echecs, depuis, bloqueJusqua }, maintenant),
  };
}

export function messageBlocageConnexion(minutes: number): string {
  const n = Math.max(1, Math.ceil(minutes));
  return `Trop de tentatives de connexion. Réessayez dans ${n} minute${n > 1 ? 's' : ''}.`;
}

/**
 * Valeur saisie par l'appelant, rendue sûre pour une ligne de journal : les
 * caractères de contrôle et les sauts de ligne Unicode deviennent « ? » (sinon
 * un email piégé fabriquerait de fausses lignes), et la longueur est bornée.
 */
export function pourJournal(valeur: unknown, max = 200): string {
  const texte = String(valeur ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return texte.length > max ? `${texte.slice(0, max)}...` : texte;
}

/**
 * Origine d'une requête pour le journal. Avec `trust proxy`, `req.ip` est la
 * première adresse de X-Forwarded-For, que l'appelant choisit librement : on
 * journalise toute la chaîne, dont la dernière adresse est celle que le proxy
 * a réellement vue.
 */
export function origineConnexion(req: { ip?: string; ips?: string[] }): string {
  const chaine = Array.isArray(req.ips) ? req.ips.filter(Boolean) : [];
  if (chaine.length > 1) return chaine.join(', ');
  return req.ip || chaine[0] || 'adresse inconnue';
}
