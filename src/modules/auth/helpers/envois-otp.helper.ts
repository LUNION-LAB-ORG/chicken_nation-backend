/**
 * Plafonds d'ENVOI des codes de connexion (Twilio : WhatsApp, et SMS en
 * secours quand WhatsApp échoue, par exemple pour un numéro sans WhatsApp).
 *
 * Tous les envois de code passent par EnvoisOtpService : connexion client
 * (`POST /auth/customer/login`) et livreurs (inscription, mot de passe
 * oublié). Ces routes sont publiques et chaque appel coûte un message.
 *
 * Barrières, de la plus fine à la plus large :
 *  - délai entre deux envois au même numéro (30 s client, 60 s livreur) ;
 *  - par numéro : MAX_ENVOIS_PAR_NUMERO codes par heure ;
 *  - numéro inconnu (aucun compte qui ait déjà validé ce numéro) : plafond
 *    horaire commun, réglable par OTP_ENVOIS_MAX_PAR_HEURE. C'est le filet qui
 *    borne la facture. Il ne s'applique PAS aux comptes connus : en épuisant ce
 *    plafond avec des numéros inventés, un script bloquait sinon la connexion
 *    de tous les clients ;
 *  - tout numéro hors +225, connu ou non : plafond commun plus serré, réglable
 *    par OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE (20 par heure par défaut). La fraude
 *    au « SMS pumping » vise les numéros étrangers surtaxés, que le fraudeur
 *    contrôle : il reçoit le code, le valide, et son numéro devient « connu ».
 *    Être connu ne prouve donc rien hors de Côte d'Ivoire. Deux compteurs
 *    distincts, au même plafond : un pour les numéros inconnus, un pour les
 *    comptes connus. Sinon, 20 numéros étrangers inventés par heure
 *    suffisaient à bloquer la connexion de tous les clients à numéro étranger ;
 *    le fraudeur, lui, doit d'abord valider ses numéros un par un sous le
 *    plafond des inconnus ;
 *  - par adresse IP : ThrottlerGuard sur la route (complément seulement,
 *    `trust proxy` rend l'IP falsifiable).
 *
 * Les compteurs vivent dans Redis et sont ATOMIQUES (INCR, SET NX) : une
 * rafale de requêtes simultanées ne passe pas à travers. Fonctions pures ici,
 * les accès à Redis sont dans EnvoisOtpService.
 */

export const MAX_ENVOIS_PAR_NUMERO = 5;
export const FENETRE_ENVOIS_MS = 60 * 60 * 1000; // 1 h
export const MAX_ENVOIS_NOUVEAUX_PAR_DEFAUT = 400;
export const MAX_ENVOIS_ETRANGER_PAR_DEFAUT = 20;

export const MESSAGE_TROP_DE_CODES_NUMERO =
  'Trop de codes demandés pour ce numéro. Réessayez dans une heure.';
export const MESSAGE_TROP_DE_CODES_GLOBAL =
  "L'envoi des codes est momentanément saturé. Réessayez dans quelques minutes.";
export const MESSAGE_TROP_DE_DEMANDES_IP =
  'Trop de demandes de code. Réessayez dans une minute.';
export const MESSAGE_TROP_D_ESSAIS_IP =
  "Trop d'essais de code. Réessayez dans une minute.";
export const MESSAGE_NUMERO_INVALIDE = 'Numéro de téléphone invalide.';
export const MESSAGE_CODE_INVALIDE = 'Le code compte 4 chiffres.';

/** Même texte pour les clients et les livreurs quand un code vient de partir. */
export function messageDelaiEnvoi(secondes: number): string {
  const n = Math.max(1, Math.ceil(secondes));
  return `Un code vient d'être envoyé. Réessayez dans ${n} seconde${n > 1 ? 's' : ''}.`;
}

// Les clés ne dépendent que des chiffres : une autre graphie du même numéro
// retombe sur le même compteur. Noms distincts de ceux de l'ancien compteur
// (`otp-envois:numero:…`, objet JSON rangé par le cache) : INCR sur une de ces
// valeurs échouerait pendant l'heure qui suit la mise en production.
const chiffres = (telephone: string) => String(telephone ?? '').replace(/\D/g, '');

export function cleDelaiEnvoi(telephone: string): string {
  return `otp-envois:delai:${chiffres(telephone)}`;
}

export function cleEnvoisNumero(telephone: string): string {
  return `otp-envois:par-numero:${chiffres(telephone)}`;
}

const INDICATIF_CI = '225';

export const CLE_ENVOIS_NOUVEAUX = 'otp-envois:global:nouveaux';
export const CLE_ENVOIS_ETRANGER = 'otp-envois:global:etranger';
export const CLE_ENVOIS_ETRANGER_CONNUS = 'otp-envois:global:etranger-connus';

/** Plafond lu dans l'environnement ; toute valeur invalide donne le défaut. */
export function plafondDepuisEnv(valeur: string | undefined, defaut: number): number {
  const n = Number(valeur);
  return Number.isInteger(n) && n > 0 ? n : defaut;
}

export interface PlafondEnvoi {
  cle: string;
  max: number;
  message: string;
  /** Plafond commun à tous les numéros : son dépassement est journalisé en erreur. */
  commun: boolean;
}

/**
 * Compteurs à prendre pour un envoi, du plus fin au plus large.
 *
 * `compteConnu` : un compte a déjà prouvé qu'il détient ce numéro (client qui
 * a déjà validé un code, livreur inscrit). Un compte simplement créé par une
 * demande de code ne compte pas : sinon un script créerait des comptes à la
 * chaîne, puis leur enverrait des codes hors de tout plafond commun.
 */
export function plafondsEnvoi(
  telephone: string,
  compteConnu: boolean,
  env: Record<string, string | undefined>,
): PlafondEnvoi[] {
  const plafonds: PlafondEnvoi[] = [
    {
      cle: cleEnvoisNumero(telephone),
      max: MAX_ENVOIS_PAR_NUMERO,
      message: MESSAGE_TROP_DE_CODES_NUMERO,
      commun: false,
    },
  ];

  // Le téléphone arrive sous forme canonique `+<indicatif>…` (client comme livreur).
  // Compteur à part pour les comptes connus : les numéros inventés ne l'entament pas.
  if (!chiffres(telephone).startsWith(INDICATIF_CI)) {
    plafonds.push({
      cle: compteConnu ? CLE_ENVOIS_ETRANGER_CONNUS : CLE_ENVOIS_ETRANGER,
      max: plafondDepuisEnv(env.OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE, MAX_ENVOIS_ETRANGER_PAR_DEFAUT),
      message: MESSAGE_TROP_DE_CODES_GLOBAL,
      commun: true,
    });
  }

  if (!compteConnu) {
    plafonds.push({
      cle: CLE_ENVOIS_NOUVEAUX,
      max: plafondDepuisEnv(env.OTP_ENVOIS_MAX_PAR_HEURE, MAX_ENVOIS_NOUVEAUX_PAR_DEFAUT),
      message: MESSAGE_TROP_DE_CODES_GLOBAL,
      commun: true,
    });
  }
  return plafonds;
}

/** Secondes restantes d'un délai d'après le PTTL de Redis (repli : le délai entier). */
export function secondesRestantes(pttl: unknown, delaiMs: number): number {
  const ms = typeof pttl === 'number' && pttl > 0 ? pttl : delaiMs;
  return Math.max(1, Math.ceil(ms / 1000));
}
