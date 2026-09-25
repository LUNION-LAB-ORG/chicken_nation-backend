/**
 * Verrouillage des tentatives des livreurs, PAR TÉLÉPHONE.
 *
 * Le code de connexion d'un livreur a 4 chiffres (10 000 combinaisons), tout
 * comme les codes reçus par SMS. Sans plafond, on les devine en quelques
 * minutes. La limite par adresse IP ne suffit pas : `trust proxy` rend l'IP
 * falsifiable par X-Forwarded-For. On compte donc les tentatives par numéro.
 *
 * Stockage : la table OtpVerificationAttempt, déjà utilisée par la
 * vérification de code des clients (aucune migration). Sa colonne `phone` est
 * un VARCHAR unique sans longueur : elle accepte une clé préfixée.
 *
 *  - Codes reçus par SMS : la clé est le téléphone normalisé, SANS préfixe.
 *    La table des codes est partagée avec les clients : un code envoyé à un
 *    client est accepté par la vérification livreur du même numéro. Le
 *    compteur doit donc être commun aux deux parcours, sinon chaque route
 *    offrirait ses propres essais sur le même jeu de codes.
 *  - Connexion : `livreur-connexion:` (fenêtre de 15 minutes) et
 *    `livreur-connexion-jour:` (fenêtre de 24 heures). La seconde clé évite
 *    qu'un tiers essaie 5 codes tous les quarts d'heure pendant des jours.
 *
 * Fonctions pures : le service lit la base, appelle ces fonctions et écrit.
 */

const MINUTE_MS = 60 * 1000;
const HEURE_MS = 60 * MINUTE_MS;

export interface PolitiqueTentatives {
  /** Tentatives admises dans la fenêtre ; la suivante est refusée. */
  max: number;
  /** Durée de la fenêtre de comptage. */
  fenetreMs: number;
  /** Durée du verrou posé quand le plafond est atteint. */
  blocageMs: number;
}

/** Vérification d'un code SMS : même politique que la vérification client. */
export const POLITIQUE_CODE: PolitiqueTentatives = {
  max: 5,
  fenetreMs: 15 * MINUTE_MS,
  blocageMs: 15 * MINUTE_MS,
};

/** Connexion : 5 essais par quart d'heure. */
export const POLITIQUE_CONNEXION: PolitiqueTentatives = {
  max: 5,
  fenetreMs: 15 * MINUTE_MS,
  blocageMs: 15 * MINUTE_MS,
};

/**
 * Connexion, sur la journée : au-delà de 15 essais en 24 heures, verrou de
 * 24 heures. Une réinitialisation du mot de passe par SMS le lève.
 */
export const POLITIQUE_CONNEXION_JOUR: PolitiqueTentatives = {
  max: 15,
  fenetreMs: 24 * HEURE_MS,
  blocageMs: 24 * HEURE_MS,
};

/**
 * Délai minimum entre deux envois de code au même numéro. Aligné sur le
 * compte à rebours de 60 secondes de l'écran de saisie du code.
 */
export const DELAI_RENVOI_CODE_MS = 60 * 1000;

/** Réponse de la limite par adresse IP (garde de débit, fenêtre d'une minute). */
export const MESSAGE_TROP_DE_DEMANDES = 'Trop de demandes. Réessayez dans une minute.';

const PREFIXE_CONNEXION = 'livreur-connexion:';
const PREFIXE_CONNEXION_JOUR = 'livreur-connexion-jour:';

/**
 * `+` suivi des chiffres seuls : `+225 07 07-00`, `2250707…` et `+2250707…`
 * donnent la même clé, pour qu'une autre graphie ne reparte pas de zéro.
 */
export function normaliserTelephone(phone: string): string {
  return `+${String(phone ?? '').replace(/\D/g, '')}`;
}

/** Clé du compteur des codes SMS (commune avec la vérification client). */
export function cleVerificationCode(phone: string): string {
  return normaliserTelephone(phone);
}

/** Clé du compteur de connexion sur 15 minutes. */
export function cleConnexion(phone: string): string {
  return `${PREFIXE_CONNEXION}${normaliserTelephone(phone)}`;
}

/** Clé du compteur de connexion sur 24 heures. */
export function cleConnexionJour(phone: string): string {
  return `${PREFIXE_CONNEXION_JOUR}${normaliserTelephone(phone)}`;
}

/** Ce que le service lit d'une ligne OtpVerificationAttempt. */
export interface EtatTentatives {
  failed_count: number;
  window_start: Date;
  locked_until: Date | null;
}

/** Durée de verrou restante en millisecondes, 0 si le numéro n'est pas verrouillé. */
export function resteBlocageMs(etat: EtatTentatives | null, maintenant: Date): number {
  if (!etat?.locked_until) return 0;
  const reste = etat.locked_until.getTime() - maintenant.getTime();
  return reste > 0 ? reste : 0;
}

/** Une fenêtre ouverte avant cette date est écoulée. */
export function debutFenetreValide(maintenant: Date, politique: PolitiqueTentatives): Date {
  return new Date(maintenant.getTime() - politique.fenetreMs);
}

/**
 * Le compteur doit-il repartir de zéro ? Oui si le verrou est échu, ou, sans
 * verrou, si la fenêtre est écoulée. Un verrou encore actif n'est jamais
 * effacé, même quand sa fenêtre est finie.
 */
export function estPerime(
  etat: EtatTentatives,
  maintenant: Date,
  politique: PolitiqueTentatives,
): boolean {
  if (etat.locked_until) return etat.locked_until.getTime() <= maintenant.getTime();
  return etat.window_start.getTime() < debutFenetreValide(maintenant, politique).getTime();
}

/**
 * La tentative de ce rang est-elle refusée d'office ? Le rang est compté AVANT
 * de juger la tentative : les requêtes simultanées reçoivent chacune un rang
 * différent, et seules les `max` premières sont examinées.
 */
export function depassePlafond(rang: number, politique: PolitiqueTentatives): boolean {
  return rang > politique.max;
}

/** Après un échec au rang donné, faut-il poser le verrou ? */
export function doitVerrouiller(rang: number, politique: PolitiqueTentatives): boolean {
  return rang >= politique.max;
}

/** Fin du verrou posé maintenant. */
export function finBlocage(maintenant: Date, politique: PolitiqueTentatives): Date {
  return new Date(maintenant.getTime() + politique.blocageMs);
}

/** « Trop de tentatives. Réessayez dans 15 minutes. » ou « … dans 24 heures. » */
export function messageTropDeTentatives(resteMs: number): string {
  const minutes = Math.max(1, Math.ceil(resteMs / MINUTE_MS));
  if (minutes <= 60) {
    return `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`;
  }
  const heures = Math.ceil(minutes / 60);
  return `Trop de tentatives. Réessayez dans ${heures} heure${heures > 1 ? 's' : ''}.`;
}

/** Même texte que le parcours client quand un code vient de partir. */
export function messageDelaiRenvoi(secondes: number): string {
  const n = Math.max(1, Math.ceil(secondes));
  return `Un code vient d'être envoyé. Réessayez dans ${n} seconde${n > 1 ? 's' : ''}.`;
}
