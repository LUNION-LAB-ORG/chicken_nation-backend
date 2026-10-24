import { ShiftAssignmentStatus, ShiftType } from '@prisma/client';

import { journeeDeService } from 'src/modules/course/helpers/journee-service.rules';

/**
 * PLANNING DU JOUR (conception du 24/10, 11.4 et 11.5) : qui est prévu
 * aujourd'hui, au matin et au soir, d'après les plannings envoyés ou
 * confirmés (le livreur ne voit pas un brouillon), et qui est au repos.
 *
 * Le jour est celui de la journée de service (05 h à 05 h, heure d'Abidjan =
 * UTC) : à 0 h 40, c'est encore le planning de la veille. Les heures des
 * créneaux (« 09:00 », « 15:00 ») sont celles d'Abidjan, donc UTC.
 */

/** Ce que le serveur lit des plannings du jour (`DeliverersService.lirePlanningDuJour`). */
export interface PlanningDuJourLu {
  /** Jour du planning (minuit UTC), celui de la journée de service. */
  jour: Date;
  /** Plannings SENT ou CONFIRMED qui couvrent ce jour, avec leurs créneaux de CE jour. */
  plans: Array<{
    id: string;
    restaurant_id: string;
    shifts: Array<{
      type: ShiftType;
      start_time: string;
      end_time: string;
      assignments: Array<{ deliverer_id: string; status: ShiftAssignmentStatus }>;
    }>;
  }>;
  /** Livreurs au repos ce jour (`RestDay`, toute source). */
  repos: string[];
  /** Livreurs qui ont répondu « Non » au point du matin de ce jour (`DailyPresenceCheck` ABSENT). */
  absents: string[];
}

/** Réponse d'un livreur à un créneau, `null` : pas sur ce créneau. */
export type ReponseCreneau = ShiftAssignmentStatus | null;

export interface CreneauDuJour {
  matin: ReponseCreneau;
  soir: ReponseCreneau;
  repos: boolean;
}

/** Une affectation du jour, avec les bornes du créneau. */
export interface AffectationDuJour {
  deliverer_id: string;
  restaurant_id: string;
  type: ShiftType;
  statut: ShiftAssignmentStatus;
  debut: Date;
  fin: Date;
}

const UNE_JOURNEE_MS = 24 * 60 * 60 * 1000;

/** Jour du planning à cet instant : la date (minuit UTC) du début de la journée de service. */
export function jourDuPlanning(maintenant: Date): Date {
  const { debut } = journeeDeService(maintenant);
  return new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), debut.getUTCDate()));
}

/** « 09:00 » le jour donné ; `null` si l'heure est illisible. */
function aLHeure(jour: Date, hhmm: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return new Date(jour.getTime() + (h * 60 + min) * 60_000);
}

/** Début et fin d'un créneau du jour ; une fin avant le début passe au lendemain (créneau de nuit). */
export function bornesDuCreneau(
  jour: Date,
  startTime: string,
  endTime: string,
): { debut: Date; fin: Date } | null {
  const debut = aLHeure(jour, startTime);
  const fin = aLHeure(jour, endTime);
  if (!debut || !fin) return null;
  return { debut, fin: fin.getTime() > debut.getTime() ? fin : new Date(fin.getTime() + UNE_JOURNEE_MS) };
}

/** Toutes les affectations du jour, réponse comprise (refusées aussi). */
export function affectationsDuJour(planning: PlanningDuJourLu): AffectationDuJour[] {
  const sortie: AffectationDuJour[] = [];
  for (const plan of planning.plans) {
    for (const shift of plan.shifts) {
      const bornes = bornesDuCreneau(planning.jour, shift.start_time, shift.end_time);
      if (!bornes) continue;
      for (const a of shift.assignments) {
        sortie.push({
          deliverer_id: a.deliverer_id,
          restaurant_id: plan.restaurant_id,
          type: shift.type,
          statut: a.status,
          debut: bornes.debut,
          fin: bornes.fin,
        });
      }
    }
  }
  return sortie;
}

/** Matin, soir et repos d'un livreur aujourd'hui (vue Livreurs « Aujourd'hui »). */
export function creneauDuJour(planning: PlanningDuJourLu, delivererId: string): CreneauDuJour {
  const creneau: CreneauDuJour = { matin: null, soir: null, repos: planning.repos.includes(delivererId) };
  for (const a of affectationsDuJour(planning)) {
    if (a.deliverer_id !== delivererId) continue;
    if (a.type === ShiftType.MORNING) creneau.matin = a.statut;
    else creneau.soir = a.statut;
  }
  return creneau;
}

/**
 * Livreurs prévus aujourd'hui dans chaque restaurant qui a un planning envoyé
 * ou confirmé pour ce jour : affectés à un créneau du jour et pas refusé, hors
 * repos (le livreur peut poser lui-même un repos sans que ses créneaux
 * disparaissent). Un restaurant absent de la carte n'a pas de planning.
 */
export function prevusParRestaurant(planning: PlanningDuJourLu): Map<string, Set<string>> {
  const prevus = new Map<string, Set<string>>();
  for (const plan of planning.plans) {
    if (!prevus.has(plan.restaurant_id)) prevus.set(plan.restaurant_id, new Set());
  }
  const repos = new Set(planning.repos);
  for (const a of affectationsDuJour(planning)) {
    if (a.statut === ShiftAssignmentStatus.REFUSED || repos.has(a.deliverer_id)) continue;
    prevus.get(a.restaurant_id)?.add(a.deliverer_id);
  }
  return prevus;
}
