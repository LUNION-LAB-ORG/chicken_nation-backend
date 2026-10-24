/**
 * RETARD D'UNE TOURNÉE, règle pure commune (conception du 24/10, 11.0).
 *
 * Une seule règle pour tous les écrans qui disent « Fin vers 13 h 05 » ou
 * « En retard de 12 min » : groupes hors restaurant, tiroir d'une commande,
 * bandeau des restaurants, En direct, et l'alerte du cron `detecterRetards`.
 *
 *  - fin prévue : base de la tournée + `estimated_duration_min` (durée figée
 *    au retrait, arrêts compris). Base : `parti_at` quand le départ est réel,
 *    sinon `picked_up_at` quand un départ est noté sans être réel (ancienne
 *    appli, fenêtre fermée d'office). Livreur pas encore parti (`parti_at`
 *    nul, fenêtre d'ajout ouverte, Turbo) : pas de fin prévue. C'est la même
 *    base que l'heure d'arrivée prévue du suivi d'une commande
 *    (`suiviLivraison`), qui la lit ici ;
 *  - en retard : course IN_DELIVERY, alerte déjà donnée (`delay_alerted_at`),
 *    ou temps écoulé depuis le retrait au moins égal à la durée estimée
 *    multipliée par le réglage `course.delay_alert_factor`. C'est la règle du
 *    cron, qui la lit ici ;
 *  - retard en minutes : au-delà de la fin prévue, seulement quand la course
 *    est en retard ; `null` sans fin prévue ou sans minute pleine.
 *
 * Accepte des dates ou leur texte ISO (course lue en base ou déjà sérialisée).
 */
import { CourseStatut } from '@prisma/client';

import { estDepartReel } from './depart.rules';

type DateLue = Date | string | null | undefined;

/** Ce que la règle lit d'une course. */
export interface CourseTourneeLue {
  statut?: string | null;
  picked_up_at?: DateLue;
  parti_at?: DateLue;
  motif_depart?: string | null;
  estimated_duration_min?: number | null;
  delay_alerted_at?: DateLue;
}

const UNE_MINUTE_MS = 60_000;

const date = (v: DateLue): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Le livreur a-t-il vraiment quitté le restaurant ? Motif du serveur
 * (`MOTIFS_DEPART_REEL`) ; sans motif (course d'avant le motif), un départ
 * noté après la validation du retrait.
 */
export function departEstReel(course: CourseTourneeLue): boolean {
  const parti = date(course.parti_at);
  if (!parti) return false;
  if (course.motif_depart) return estDepartReel(course.motif_depart);
  const retrait = date(course.picked_up_at);
  return !!retrait && parti.getTime() > retrait.getTime();
}

/** Début de la tournée : départ réel, sinon retrait d'une course partie, sinon `null`. */
export function baseDeTournee(course: CourseTourneeLue): Date | null {
  const parti = date(course.parti_at);
  if (!parti) return null;
  return departEstReel(course) ? parti : date(course.picked_up_at);
}

/** Heure prévue de la fin de la tournée, `null` sans départ ou sans durée estimée. */
export function finTourneePrevue(course: CourseTourneeLue): Date | null {
  const base = baseDeTournee(course);
  const duree = course.estimated_duration_min;
  if (!base || typeof duree !== 'number' || duree <= 0) return null;
  return new Date(base.getTime() + duree * UNE_MINUTE_MS);
}

/** La tournée dépasse-t-elle nettement sa durée estimée ? Même règle que `CourseTask.detecterRetards`. */
export function enRetard(course: CourseTourneeLue, maintenant: Date, facteur: number): boolean {
  if (course.statut !== CourseStatut.IN_DELIVERY) return false;
  if (date(course.delay_alerted_at)) return true;
  const retrait = date(course.picked_up_at);
  const duree = course.estimated_duration_min;
  if (!retrait || typeof duree !== 'number') return false;
  const ecouleMin = (maintenant.getTime() - retrait.getTime()) / UNE_MINUTE_MS;
  return ecouleMin >= duree * facteur;
}

/** Minutes pleines au-delà de la fin prévue, quand la tournée est en retard ; sinon `null`. */
export function retardMin(course: CourseTourneeLue, maintenant: Date, facteur: number): number | null {
  if (!enRetard(course, maintenant, facteur)) return null;
  const fin = finTourneePrevue(course);
  if (!fin) return null;
  const minutes = Math.floor((maintenant.getTime() - fin.getTime()) / UNE_MINUTE_MS);
  return minutes > 0 ? minutes : null;
}
