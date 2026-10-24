/**
 * DÉPART DU RESTAURANT, règles pures (planificateur v2, conception 3.8).
 *
 * La fenêtre d'ajout après le retrait ne s'ouvre que pour un livreur interne
 * dont l'appli sait afficher une commande ajoutée après le retrait
 * (protocole 3 ou plus), réglage actif, restaurant en v2. Sinon elle est
 * fermée d'office à la validation : `Course.parti_at` est posé tout de suite.
 *
 * Le départ se DÉDUIT d'abord (demande du 23/10 : le livreur n'a rien à
 * toucher) : position reçue hors du rayon de départ, première livraison
 * démarrée, fenêtre écoulée. « Je pars » reste possible, jamais obligatoire.
 * Au départ, la nouvelle appli ne démarre plus elle-même la première
 * livraison : le serveur la démarre (celle dont la commande est remise).
 */
import { DeliveryStatut, OrderStatus } from '@prisma/client';

import { positionAssezPrecise } from './arrivee-auto.rules';
import { haversineMeters, ILatLng } from './geo.helper';
import {
  PROTOCOLE_AJOUT_APRES_RETRAIT,
  ReglagesPlanification,
  VersionPlanificateur,
} from './planification.rules';
import { STATUTS_COMMANDE_REMISE } from './remise-course.rules';

/** Départ enregistré hors du passage du planificateur (journal `COURSE_PARTIE`). */
export type MotifDepartDirect = 'BOUTON' | 'POSITION' | 'LIVRAISON_DEMARREE';

/**
 * Départs où le livreur a vraiment quitté le comptoir, ou n'y attend plus
 * rien (fenêtre écoulée sans sac attendu). Les autres motifs écrits dans
 * `Course.motif_depart` (ANCIENNE_APPLI, REPLI_V1, AJOUT_COUPE, SANS_LIVREUR,
 * DEJA_PARTI, SANS_RETRAIT) ferment une fenêtre qui ne devait pas s'ouvrir :
 * le livreur est peut-être encore au comptoir, la caisse remet peut-être le
 * second sac.
 */
export const MOTIFS_DEPART_REEL: readonly string[] = ['BOUTON', 'POSITION', 'LIVRAISON_DEMARREE', 'FENETRE_ECHUE'];

/** Vrai si ce motif de départ (`Course.motif_depart`) est un départ réel. */
export function estDepartReel(motif: string | null | undefined): boolean {
  return !!motif && MOTIFS_DEPART_REEL.includes(motif);
}

/**
 * Position reçue APRÈS la validation du retrait, à plus du rayon de départ
 * du restaurant : le livreur est parti. Une position d'avant le retrait ne
 * dit rien (il arrivait). Sans coordonnées du restaurant : rien à conclure.
 */
export function sortiDuRestaurant(p: {
  position: ILatLng | null;
  position_at: Date | null;
  restaurant: ILatLng | null;
  picked_up_at: Date | null;
  departRayonM: number;
  /** Précision annoncée par le GPS (mètres) : au-delà de 80 m, la position ne décide rien. */
  precision_m?: number | null;
}): boolean {
  if (!p.position || !p.position_at || !p.restaurant || !p.picked_up_at) return false;
  if (!positionAssezPrecise(p.precision_m)) return false;
  if (p.position_at.getTime() <= p.picked_up_at.getTime()) return false;
  return haversineMeters(p.position, p.restaurant) > p.departRayonM;
}

/** Livraison telle que lue pour le départ. */
export interface LivraisonAuDepart {
  id: string;
  statut: DeliveryStatut;
  sequence_order: number;
  ajoutee_apres_retrait?: boolean | null;
  order: { status: OrderStatus };
}

/** Commande ajoutée après le retrait et pas encore remise : elle ne part pas avec le livreur. */
export function ajoutPasEncoreRemis(l: Pick<LivraisonAuDepart, 'statut' | 'ajoutee_apres_retrait' | 'order'>): boolean {
  return l.ajoutee_apres_retrait === true && l.statut === DeliveryStatut.PENDING && l.order.status === OrderStatus.READY;
}

/**
 * Livraison que le serveur démarre au départ : la première de la tournée
 * dont la commande est remise, seulement pour la nouvelle appli (protocole 3
 * ou plus ; l'ancienne démarre la sienne dès la validation) et si aucune
 * livraison n'est déjà commencée. `null` sinon.
 */
export function livraisonADemarrerAuDepart(
  livraisons: readonly LivraisonAuDepart[],
  protocoleAppli: number | null,
): string | null {
  if ((protocoleAppli ?? 0) < PROTOCOLE_AJOUT_APRES_RETRAIT) return null;
  const commencee = livraisons.some((l) => l.statut !== DeliveryStatut.PENDING && l.statut !== DeliveryStatut.CANCELLED);
  if (commencee) return null;
  const premiere = [...livraisons]
    .sort((a, b) => a.sequence_order - b.sequence_order)
    .find((l) => l.statut === DeliveryStatut.PENDING && STATUTS_COMMANDE_REMISE.includes(l.order.status));
  return premiere?.id ?? null;
}

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
