/**
 * DÉPART DU RESTAURANT, règles pures (planificateur v2, conception 3.8).
 *
 * La fenêtre d'ajout après le retrait ne s'ouvre que pour un livreur interne
 * dont l'appli sait afficher une commande ajoutée après le retrait
 * (protocole 3 ou plus), réglage actif, restaurant en v2. Sinon elle est
 * fermée d'office à la validation : `Course.parti_at` est posé tout de suite.
 */
import {
  PROTOCOLE_AJOUT_APRES_RETRAIT,
  ReglagesPlanification,
  VersionPlanificateur,
} from './planification.rules';

/** Pourquoi la fenêtre est fermée à la validation (journal). */
export type MotifFermetureValidation = 'REPLI_V1' | 'SANS_LIVREUR' | 'AJOUT_COUPE' | 'ANCIENNE_APPLI';

export function motifFermetureALaValidation(p: {
  version: VersionPlanificateur;
  deliverer_id: string | null;
  protocole_appli: number | null;
  reglages: Pick<ReglagesPlanification, 'ajoutApresRetrait' | 'ajoutApresRetraitMaxS'>;
}): MotifFermetureValidation | null {
  if (p.version === 'v1') return 'REPLI_V1';
  if (!p.deliverer_id) return 'SANS_LIVREUR';
  if (!p.reglages.ajoutApresRetrait || p.reglages.ajoutApresRetraitMaxS <= 0) return 'AJOUT_COUPE';
  if ((p.protocole_appli ?? 0) < PROTOCOLE_AJOUT_APRES_RETRAIT) return 'ANCIENNE_APPLI';
  return null;
}

// Textes : livreur (tutoiement, court) et caisse (impersonnel, comme l'existant).

/** Livreur : « Je pars » sur une course qui n'est pas la sienne. */
export const MESSAGE_COURSE_PAS_A_TOI = "Cette course n'est pas à toi.";
/** Livreur : « Je pars » avant la remise des commandes. */
export const MESSAGE_DEPART_AVANT_RETRAIT = 'Commande pas encore remise.';
/** Caisse : retrait complémentaire alors que le livreur vient de partir. */
export const MESSAGE_LIVREUR_PARTI = "Le livreur vient de partir : la remise n'est pas enregistrée.";
/** Caisse : retrait complémentaire sans commande prête à remettre. */
export const MESSAGE_RIEN_A_REMETTRE = 'Toutes les commandes de cette course ont déjà été remises au livreur.';
