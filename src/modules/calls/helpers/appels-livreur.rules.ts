import { CallStatus, UserRole } from '@prisma/client';

import { ROLES_APPEL_LIVREUR } from '../constants/calls.constants';

/**
 * Appels avec les livreurs (demande du 24/10) : règles pures, sans base ni
 * socket, testées à part.
 *
 *  - Le livreur appelle le service client depuis son appli : la sonnerie du
 *    centre d'appels dit qui appelle (`appelantLivreur`).
 *  - Le service client appelle un livreur : seuls l'admin et le rôle
 *    CALL_CENTER le peuvent (`peutAppelerLivreur`).
 *  - Fin d'un appel : chacune des parties, sauf celle qui raccroche, est
 *    prévenue (`partiesAPrevenir`).
 */

/** Livreur tel qu'il est lu pour un appel (prénom, nom, téléphone, restaurant). */
export interface LivreurLu {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  restaurant?: { name?: string | null } | null;
}

/**
 * Le livreur qui appelle, tel que le personnel le voit : sur `call:incoming`,
 * sur chaque entrée de `GET /calls/ringing` et sur `GET /calls/active`.
 */
export interface AppelantLivreur {
  id: string;
  /** « Koffi Kouassi » ; à défaut son téléphone ; à défaut « Livreur ». */
  nom: string;
  /** Numéro complet (+225…). */
  telephone: string | null;
  /** Nom du restaurant du livreur. */
  restaurant: string | null;
  /** Référence de la course dont il parle (« CRS-A1 »), null sans course. */
  course_reference: string | null;
}

const texte = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** « Koffi Kouassi » ; à défaut son téléphone ; à défaut « Livreur ». */
export function nomLivreur(d: Pick<LivreurLu, 'first_name' | 'last_name' | 'phone'> | null | undefined): string {
  if (!d) return 'Livreur';
  const nom = [texte(d.first_name), texte(d.last_name)].filter(Boolean).join(' ');
  return nom || texte(d.phone) || 'Livreur';
}

export function appelantLivreur(
  d: LivreurLu,
  course?: { reference?: string | null } | null,
): AppelantLivreur {
  return {
    id: d.id,
    nom: nomLivreur(d),
    telephone: texte(d.phone),
    restaurant: texte(d.restaurant?.name),
    course_reference: texte(course?.reference),
  };
}

/**
 * Réglage `calls.livreurs_actif` : actif par défaut (absent, vide ou valeur
 * inconnue). Seule une valeur explicite (`0`, `false`, `off`, `non`, `no`)
 * coupe les appels.
 */
export function lireAppelsLivreursActifs(brut: string | null | undefined): boolean {
  const v = (brut ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'non', 'no'].includes(v);
}

/** Ce rôle du personnel peut-il appeler un livreur ? */
export function peutAppelerLivreur(role: UserRole | string | null | undefined): boolean {
  return !!role && (ROLES_APPEL_LIVREUR as readonly string[]).includes(role);
}

/** Une partie d'un appel : un membre du personnel ou un livreur. */
export interface PartieAppel {
  type: 'user' | 'deliverer';
  id: string;
}

/** Parties d'un appel, telles que la ligne `calls` les porte. */
export interface PartiesDeLAppel {
  caller_id: string | null;
  caller_deliverer_id: string | null;
  answered_by_id: string | null;
  target_deliverer_id: string | null;
}

/**
 * Qui prévenir de la fin d'un appel en cours : l'appelant (personnel ou
 * livreur), le membre du personnel qui a décroché et le livreur appelé, sauf
 * celui qui raccroche. Un admin qui coupe l'appel des autres les prévient tous.
 */
export function partiesAPrevenir(appel: PartiesDeLAppel, acteur: PartieAppel): PartieAppel[] {
  const parties: PartieAppel[] = [];
  const ajouter = (type: PartieAppel['type'], id: string | null) => {
    if (!id) return;
    if (type === acteur.type && id === acteur.id) return;
    if (parties.some((p) => p.type === type && p.id === id)) return;
    parties.push({ type, id });
  };
  ajouter('user', appel.caller_id);
  ajouter('deliverer', appel.caller_deliverer_id);
  ajouter('user', appel.answered_by_id);
  ajouter('deliverer', appel.target_deliverer_id);
  return parties;
}

/**
 * Où en est l'appel, vu du livreur (`GET /calls/deliverer/active`) :
 *  - `calling`   : il appelle le service client, ça sonne ;
 *  - `ringing`   : le service client l'appelle, il peut décrocher ;
 *  - `connected` : en ligne.
 */
export function phasePourLivreur(
  appel: { status: CallStatus; caller_deliverer_id: string | null },
  delivererId: string,
): { direction: 'outgoing' | 'incoming'; phase: 'calling' | 'ringing' | 'connected' } {
  const sortant = appel.caller_deliverer_id === delivererId;
  if (appel.status === CallStatus.ONGOING) {
    return { direction: sortant ? 'outgoing' : 'incoming', phase: 'connected' };
  }
  return sortant
    ? { direction: 'outgoing', phase: 'calling' }
    : { direction: 'incoming', phase: 'ringing' };
}

/** Ce qu'on lit d'un livreur pour un appel (inclusions Prisma des appels). */
export const SELECT_LIVREUR_APPEL = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  restaurant: { select: { id: true, name: true } },
} as const;
