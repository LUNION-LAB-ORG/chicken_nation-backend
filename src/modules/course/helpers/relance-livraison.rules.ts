import { ConflictException, HttpException } from '@nestjs/common';
import { CourseStatut, DelivererStatus, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import {
  EtatLivreur,
  estEnPause,
  estEnPauseAuto,
  estEnService,
  messageRefusOffre,
} from 'src/modules/deliverers/helpers/disponibilite.rules';

import { livraisonLivrable, LivraisonPlusTard } from './plus-tard.rules';
import { CommandeSacLue, estSacARapporter, MESSAGE_COMMANDE_ANNULEE } from './sac-rapporte.rules';

/**
 * « RELANCER LA LIVRAISON » d'une livraison annulée par le livreur (demande
 * du 28/10), règles pures.
 *
 * Après « Annuler » du livreur (27/10), la livraison est en échec et la
 * commande reste en livraison : le sac est chez lui. Si le siège (call
 * center, administrateur) a trouvé une solution avec le client, il relance la
 * livraison AU MÊME LIVREUR, sans passage au restaurant :
 *  - il est en tournée : la livraison rejoint la fin de sa tournée ;
 *  - il n'a aucune course : une course neuve est créée pour lui, directement
 *    en livraison, livraison démarrée ;
 *  - il va au restaurant pour une autre course : refus, « Sac rapporté » à
 *    son arrivée.
 * La même ligne de livraison redevient active (même code du client) ; la
 * commande n'est jamais touchée. « Sac rapporté » (commande de nouveau
 * prête) reste l'autre geste.
 */

export const MESSAGE_SAC_DEJA_RAPPORTE = 'Sac déjà rapporté.';
export const MESSAGE_AUCUNE_LIVRAISON_ANNULEE = 'Aucune livraison annulée sur cette commande.';
export const MESSAGE_LIVREUR_VA_AU_RESTAURANT =
  'Ce livreur va au restaurant pour une autre course : Sac rapporté à son arrivée.';

/** Raison de `course:statut:changed` (siège et restaurant), et type de la ligne du journal. */
export const RAISON_LIVRAISON_RELANCEE = 'LIVRAISON_RELANCEE';

/**
 * Motif de départ de la course neuve : un motif réel, connu de la caisse et
 * du backoffice (« Parti »). Un motif nouveau ferait dire « Au comptoir » à
 * la caisse déjà installée.
 */
export const MOTIF_DEPART_RELANCE = 'LIVRAISON_DEMARREE';

/** Livraison active : à faire, en route ou chez le client. */
export const LIVRAISON_ACTIVE: DeliveryStatut[] = [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];
const COMMENCEE: DeliveryStatut[] = [DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];
const TERMINEE: DeliveryStatut[] = [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED];

/** Courses d'un livreur lues pour la relance. */
export const STATUTS_COURSE_DU_LIVREUR: CourseStatut[] = [
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];
/** Course acceptée, pas encore retirée : le livreur va au restaurant. */
const AVANT_RETRAIT: CourseStatut[] = [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT];

/** Commande lue (comme « Sac rapporté »), avec le livreur de la course. */
export type CommandeRelanceLue = CommandeSacLue;

/**
 * Livraison à relancer : la même que « Sac rapporté » (commande à livrer en
 * livraison, pas supprimée, livraison en échec, course hors Turbo), et un
 * livreur sur la course (c'est à lui qu'elle revient).
 */
export function estLivraisonARelancer(c: CommandeRelanceLue | null | undefined): boolean {
  return estSacARapporter(c) && !!c?.delivery?.course?.deliverer?.id;
}

/**
 * Peut-être un rejeu (double toucher, réponse perdue) : commande toujours en
 * livraison, livraison de nouveau active, chez un livreur. Le service vérifie
 * ensuite au journal qu'une relance de CE livreur est la dernière décision.
 */
export function peutEtreRejeuRelance(c: CommandeRelanceLue | null | undefined): boolean {
  const l = c?.delivery;
  return (
    !!c &&
    c.status === OrderStatus.PICKED_UP &&
    !!l &&
    LIVRAISON_ACTIVE.includes(l.statut as DeliveryStatut) &&
    !!l.course?.deliverer?.id
  );
}

/**
 * Plus de livraison à relancer, et pas de rejeu : 409 avec la raison.
 * Commande de nouveau prête (ou remise en préparation) après « Sac rapporté » :
 * « Sac déjà rapporté. » ; tout le reste (en cours, livrée, Turbo, sans
 * livreur) : « Aucune livraison annulée sur cette commande. ».
 */
export function refusSansRelance(status: string | null | undefined, sacRapporte: boolean): HttpException {
  if (status === OrderStatus.CANCELLED) return new ConflictException(MESSAGE_COMMANDE_ANNULEE);
  if (sacRapporte && (status === OrderStatus.READY || status === OrderStatus.IN_PROGRESS)) {
    return new ConflictException(MESSAGE_SAC_DEJA_RAPPORTE);
  }
  return new ConflictException(MESSAGE_AUCUNE_LIVRAISON_ANNULEE);
}

export type MotifRefusRelance = 'INACTIF' | 'VA_AU_RESTAURANT' | 'EN_PAUSE' | 'PAUSE_AUTO' | 'HORS_SERVICE' | 'INJOIGNABLE';

/**
 * Le livreur peut-il reprendre la livraison ? (lu comme l'affectation forcée)
 *  - inactif, supprimé ou sans restaurant : refus ;
 *  - une course acceptée ou au restaurant (avant le retrait) : refus, il va
 *    au restaurant de toute façon (« Sac rapporté » à son arrivée) ;
 *  - en livraison : permis (seul « inactif » refuse) ;
 *  - sans course : refus en pause, en pause automatique, hors service ou
 *    injoignable, avec les mots d'avant (`messageRefusOffre`).
 * Appli fermée, connexion coupée, en appel : jamais un refus (la notification
 * part ; l'appel porte sans doute sur cette livraison).
 *
 * @returns `null` si permis.
 */
export function refusLivreurRelance(
  etat: (EtatLivreur & { restaurant_id?: string | null }) | null | undefined,
  courses: readonly { statut: CourseStatut }[],
  maintenant: Date,
): { motif: MotifRefusRelance; message: string } | null {
  const refus = (motif: Exclude<MotifRefusRelance, 'VA_AU_RESTAURANT'>) => ({
    motif,
    message: messageRefusOffre(motif, etat ?? { pause_until: null, auto_pause_until: null }, maintenant),
  });
  if (
    !etat ||
    etat.status !== DelivererStatus.ACTIVE ||
    !etat.is_operational ||
    etat.entity_status !== EntityStatus.ACTIVE ||
    etat.restaurant_id === null
  ) {
    return refus('INACTIF');
  }
  if (courses.some((c) => AVANT_RETRAIT.includes(c.statut))) {
    return { motif: 'VA_AU_RESTAURANT', message: MESSAGE_LIVREUR_VA_AU_RESTAURANT };
  }
  if (courses.some((c) => c.statut === CourseStatut.IN_DELIVERY)) return null;
  if (estEnPause(etat, maintenant)) return refus('EN_PAUSE');
  if (estEnPauseAuto(etat, maintenant)) return refus('PAUSE_AUTO');
  if (!estEnService(etat)) return refus('HORS_SERVICE');
  if (etat.joignable === false) return refus('INJOIGNABLE');
  return null;
}

/** Livraison de la course cible, telle que la relance la lit. */
export type LivraisonCible = Pick<LivraisonPlusTard, 'id' | 'statut' | 'sequence_order' | 'order' | 'ajoutee_apres_retrait'>;

/**
 * Nouveaux rangs (1 à N) de la course cible : les livraisons terminées dans
 * leur ordre, puis les autres à faire dans leur ordre, puis la relancée, puis
 * les annulées. Aucun calcul de route : la tournée prévue reste la bonne pour
 * les autres clients (comme « Plus tard »).
 */
export function rangsApresRelance(
  livraisons: readonly Pick<LivraisonCible, 'id' | 'statut' | 'sequence_order'>[],
  relanceeId: string,
): Map<string, number> {
  const autres = [...livraisons].filter((l) => l.id !== relanceeId).sort((a, b) => a.sequence_order - b.sequence_order);
  const ordre = [
    ...autres.filter((l) => TERMINEE.includes(l.statut)).map((l) => l.id),
    ...autres.filter((l) => LIVRAISON_ACTIVE.includes(l.statut)).map((l) => l.id),
    relanceeId,
    ...autres.filter((l) => l.statut === DeliveryStatut.CANCELLED).map((l) => l.id),
  ];
  return new Map(ordre.map((id, i) => [id, i + 1]));
}

/**
 * La relancée démarre-t-elle tout de suite ? Course neuve : toujours. Course
 * existante : seulement si elle est partie et qu'aucune autre livraison n'est
 * commencée ni livrable (`livraisonLivrable` de « Plus tard ») ; sinon elle
 * attend, et partira quand les autres seront faites (appli, « Plus tard »,
 * départ du comptoir, inchangés).
 */
export function aDemarrerApresRelance(p: {
  nouvelle: boolean;
  parti_at: Date | string | null | undefined;
  autres: readonly Pick<LivraisonCible, 'statut' | 'order' | 'ajoutee_apres_retrait'>[];
}): boolean {
  if (p.nouvelle) return true;
  if (!p.parti_at) return false;
  return !p.autres.some((l) => COMMENCEE.includes(l.statut) || livraisonLivrable(l));
}

/** Elle attend derrière d'autres clients : « en dernier » dans la notification du livreur. */
export function relanceeEnDernier(
  demarree: boolean,
  autres: readonly Pick<LivraisonCible, 'statut'>[],
): boolean {
  return !demarree && autres.some((l) => LIVRAISON_ACTIVE.includes(l.statut));
}

type DateLue = Date | string | null | undefined;
const iso = (v: DateLue): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Livraison annulée telle que lue avant la relance (jamais le code du client). */
export interface LivraisonAnnuleeAvantRelance {
  failed_at: DateLue;
  failure_note: string | null;
  in_route_at: DateLue;
  arrived_at: DateLue;
  reportee_at: DateLue;
  customer_rating: number | null;
  customer_rating_note: string | null;
}

/**
 * `details` de la ligne LIVRAISON_RELANCEE : ce que la relance efface de la
 * livraison (échec, arrivée, report, note du client), où elle va, et qui a
 * touché le bouton. Le motif, le livreur, l'ancienne course et la commande
 * sont dans les colonnes de la ligne.
 */
export function detailsRelance(p: {
  commande: string;
  course_avant: string;
  course_apres: string;
  nouvelle_course: boolean;
  rang: number;
  demarree: boolean;
  livraison: LivraisonAnnuleeAvantRelance;
  par: { id: string | null; role: string | null };
}): Record<string, unknown> {
  const l = p.livraison;
  return {
    commande: p.commande,
    course_avant: p.course_avant,
    course_apres: p.course_apres,
    nouvelle_course: p.nouvelle_course,
    rang: p.rang,
    demarree: p.demarree,
    failed_at: iso(l.failed_at),
    failure_note: l.failure_note ?? null,
    in_route_at: iso(l.in_route_at),
    arrived_at: iso(l.arrived_at),
    reportee_at: iso(l.reportee_at),
    customer_rating: l.customer_rating ?? null,
    customer_rating_note: l.customer_rating_note ?? null,
    par: p.par,
  };
}
