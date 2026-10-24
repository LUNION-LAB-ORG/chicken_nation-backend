import { journeeDeService } from 'src/modules/course/helpers/journee-service.rules';

import {
  APPLI_FERMEE_APRES_S_DEFAUT,
  EtatLivreur,
  estEnPause,
  estEnPauseAuto,
  estEnService,
} from './disponibilite.rules';

/**
 * MINUTEUR « EN LIGNE » DU LIVREUR : son temps en ligne de la journée, tenu
 * par le serveur.
 *
 * Demande du 24/10 : « le minuteur quand on est en ligne doit toujours
 * compter même si le livreur n'est pas dans l'appli et que la fenêtre est
 * ouverte ; il doit se mettre en pause si la connexion internet est
 * interrompue, s'il ferme la fenêtre ou autre panne qui plante, et ne doit
 * pas se réinitialiser à chaque fois qu'on quitte la page d'accueil ».
 *
 * Règle : à chaque signe de vie de l'appli (position, même en arrière-plan,
 * ou requête authentifiée, là où `dernier_signal_at` est écrit), l'écart
 * depuis le signe de vie précédent est ajouté s'il est d'au plus
 * `deliverer.appli_fermee_apres_s` secondes (0 = règle de l'appli coupée :
 * défaut 180) et si le livreur était en ligne aux deux bouts : en service
 * (dans la file) ou en course, ni en pause ni en pause automatique. Un écart
 * plus long n'est pas compté : c'est une pause automatique (connexion coupée,
 * appli fermée, panne). Une pause, une reprise ou une pause automatique
 * (changement d'état dans la file) arrêtent ou relancent le compte au moment
 * exact du changement.
 *
 * Journée de service de 05 h à 05 h (journee-service.rules.ts) : un compteur
 * par livreur et par journée dans Redis, remis à 0 à 05 h, gardé 36 h.
 *
 * Deux serveurs : l'avance est faite dans Redis par un seul script (atomique),
 * et un signe de vie qui n'est pas plus récent que le dernier compté est
 * ignoré. Un même signal reçu deux fois n'est donc compté qu'une fois.
 */

/** Durée de vie d'un compteur : la journée de service et une marge. */
export const DUREE_VIE_MINUTEUR_S = 36 * 60 * 60;

/**
 * Un serveur traite au plus un signe de vie par livreur toutes les 30 s (les
 * positions arrivent toutes les 5 s en livraison). Un signe de vie sauté
 * n'est pas perdu : l'écart suivant le contient.
 */
export const INTERVALLE_MINUTEUR_MS = 30_000;

/** Compteur d'un livreur pour une journée de service. */
export interface EtatMinuteur {
  /** Temps en ligne compté dans la journée, en millisecondes. */
  ms: number;
  /** Dernier signe de vie pris en compte (millisecondes depuis 1970), `null` : aucun. */
  dernier: number | null;
  /** En ligne à ce dernier signe de vie. */
  en_ligne: boolean;
}

export interface SignalMinuteur {
  /** Moment du signe de vie (millisecondes depuis 1970). */
  a: number;
  /** En ligne jusqu'à ce signe de vie (état vu à son arrivée). */
  enLigneJusquIci: boolean;
  /** En ligne à partir de ce signe de vie (différent seulement lors d'un changement d'état). */
  enLigneDesormais: boolean;
}

export const MINUTEUR_VIDE: EtatMinuteur = { ms: 0, dernier: null, en_ligne: false };

/** Écart le plus long encore compté, en millisecondes. */
export function ecartMaxMinuteurMs(appliFermeeApresS: number): number {
  return (appliFermeeApresS > 0 ? appliFermeeApresS : APPLI_FERMEE_APRES_S_DEFAUT) * 1000;
}

/** Clé Redis du compteur : un livreur, une journée de service (`AAAA-MM-JJ` de son 05 h). */
export function cleMinuteurEnLigne(delivererId: string, maintenant: Date): string {
  const jour = journeeDeService(maintenant).debut.toISOString().slice(0, 10);
  return `livreur:en-ligne:${delivererId}:${jour}`;
}

/** En ligne : en service ou en course, ni en pause ni en pause automatique. */
export function estEnLigne(
  l: Pick<EtatLivreur, 'pause_until' | 'auto_pause_until' | 'last_available_at'>,
  enCourse: boolean,
  maintenant: Date,
): boolean {
  if (estEnPause(l, maintenant) || estEnPauseAuto(l, maintenant)) return false;
  return estEnService(l) || enCourse;
}

/**
 * Avance du compteur pour un signe de vie. Règle de référence : le script
 * Redis `SCRIPT_AVANCER_MINUTEUR` fait exactement la même chose.
 */
export function avancerMinuteur(
  etat: EtatMinuteur | null,
  signal: SignalMinuteur,
  ecartMaxMs: number,
): { etat: EtatMinuteur; ajoutMs: number } {
  const e = etat ?? MINUTEUR_VIDE;
  // Déjà compté (même signal reçu par un autre serveur) ou arrivé en retard.
  if (e.dernier !== null && signal.a <= e.dernier) return { etat: e, ajoutMs: 0 };
  const ecart = e.dernier === null ? 0 : signal.a - e.dernier;
  const ajoutMs = e.dernier !== null && e.en_ligne && signal.enLigneJusquIci && ecart <= ecartMaxMs ? ecart : 0;
  return {
    etat: { ms: e.ms + ajoutMs, dernier: signal.a, en_ligne: signal.enLigneDesormais },
    ajoutMs,
  };
}

/**
 * Secondes en ligne aujourd'hui, à l'instant : le temps compté, plus l'écart
 * en cours depuis le dernier signe de vie s'il sera compté au suivant (en
 * ligne aux deux bouts, écart pas encore trop long). L'appli peut ainsi
 * faire avancer son affichage entre deux lectures sans retour en arrière.
 */
export function secondesEnLigne(
  etat: EtatMinuteur | null,
  maintenant: number,
  enLigneMaintenant: boolean,
  ecartMaxMs: number,
): number {
  if (!etat) return 0;
  const ecart = etat.dernier === null ? 0 : maintenant - etat.dernier;
  const enCours = etat.en_ligne && enLigneMaintenant && ecart > 0 && ecart <= ecartMaxMs ? ecart : 0;
  return Math.floor((etat.ms + enCours) / 1000);
}

/** Compteur lu dans Redis (`HMGET ms dernier en_ligne`), `null` : aucun. */
export function lireEtatMinuteur(valeurs: (string | null)[]): EtatMinuteur | null {
  const [ms, dernier, enLigne] = valeurs;
  if (ms == null && dernier == null) return null;
  const n = (v: string | null | undefined) => {
    const x = Number(v);
    return v != null && Number.isFinite(x) ? x : null;
  };
  return { ms: Math.max(0, n(ms) ?? 0), dernier: n(dernier), en_ligne: enLigne === '1' };
}

/**
 * Script Redis de `avancerMinuteur`, exécuté d'un bloc (deux serveurs ne
 * peuvent pas lire le même état puis compter chacun l'écart).
 *
 * KEYS[1] : clé du compteur. ARGV : moment du signe de vie (ms), en ligne
 * jusqu'ici (1/0), en ligne désormais (1/0), écart le plus long compté (ms),
 * durée de vie (s). Réponse : millisecondes ajoutées.
 */
export const SCRIPT_AVANCER_MINUTEUR = `
local etat = redis.call('HMGET', KEYS[1], 'ms', 'dernier', 'en_ligne')
local a = tonumber(ARGV[1])
local dernier = tonumber(etat[2])
if dernier and a <= dernier then
  return 0
end
local ajout = 0
if dernier and etat[3] == '1' and ARGV[2] == '1' and a - dernier <= tonumber(ARGV[4]) then
  ajout = a - dernier
  redis.call('HINCRBY', KEYS[1], 'ms', ajout)
end
redis.call('HSET', KEYS[1], 'dernier', ARGV[1], 'en_ligne', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return ajout
`;
