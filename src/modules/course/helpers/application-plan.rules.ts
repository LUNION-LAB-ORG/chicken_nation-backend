/**
 * APPLICATION DU PLAN du planificateur v2 : petites règles pures utilisées
 * par `ApplicationPlanService` (numérotation des arrêts, textes courts,
 * lecture des commandes attendues). Testées à part.
 */
import { DeliveryStatut } from '@prisma/client';

import { libelleDirection, MotifDirection } from './direction.rules';
import { CommandeAttendue, MotifLiberation } from './planification.rules';

/**
 * Raisons portées par `course:statut:changed` quand le planificateur change
 * une course sans changer son statut. L'écouteur du planificateur les ignore
 * (sinon chaque passage en déclencherait un autre).
 */
export const RaisonsPlanificateur = {
  COURSE_CREEE: 'COURSE_CREEE',
  COMMANDE_AJOUTEE: 'COMMANDE_AJOUTEE',
  COURSES_FUSIONNEES: 'COURSES_FUSIONNEES',
  COMMANDE_DETACHEE: 'COMMANDE_DETACHEE',
  RETENUE: 'RETENUE',
  RETENUE_LEVEE: 'RETENUE_LEVEE',
  DEPART: 'DEPART',
  RETRAIT_COMPLEMENTAIRE: 'RETRAIT_COMPLEMENTAIRE',
} as const;

export type RaisonPlanificateur = (typeof RaisonsPlanificateur)[keyof typeof RaisonsPlanificateur];

const RAISONS = new Set<string>(Object.values(RaisonsPlanificateur));

/** `course:statut:changed` émis par le planificateur lui-même (ou le départ, le retrait complémentaire). */
export function estRaisonDuPlanificateur(raison: string | null | undefined): boolean {
  return !!raison && RAISONS.has(raison);
}

/** Une livraison telle que lue pour renuméroter. */
export interface LivraisonANumeroter {
  id: string;
  order_id: string;
  statut: DeliveryStatut;
  sequence_order: number;
}

/**
 * Nouveaux rangs des livraisons d'une course pour suivre `sequence`
 * (identifiants de commandes). Les livraisons déjà commencées ou terminées
 * gardent leur rang en tête (conception 2.4), puis la séquence, puis le reste
 * (annulées) dans leur ordre actuel. Rend `null` si rien ne change.
 */
export function numeroterArrets(
  livraisons: readonly LivraisonANumeroter[],
  sequence: readonly string[],
): Map<string, number> | null {
  const actuel = [...livraisons].sort((a, b) => a.sequence_order - b.sequence_order);
  const enAttente = (l: LivraisonANumeroter) => l.statut === DeliveryStatut.PENDING;
  const tete = actuel.filter((l) => !enAttente(l) && l.statut !== DeliveryStatut.CANCELLED);
  const parCommande = new Map(actuel.map((l) => [l.order_id, l]));
  const suivies = sequence
    .map((id) => parCommande.get(id))
    .filter((l): l is LivraisonANumeroter => !!l && enAttente(l));
  const vues = new Set([...tete, ...suivies].map((l) => l.id));
  const reste = actuel.filter((l) => !vues.has(l.id));
  const ordre = [...tete, ...suivies, ...reste];

  const rangs = new Map(ordre.map((l, i) => [l.id, i + 1]));
  const change = ordre.some((l) => l.sequence_order !== rangs.get(l.id));
  return change ? rangs : null;
}

/** « sur le trajet », « même zone »… pour `Course.motif_regroupement` (40 caractères au plus). */
export function libelleRegroupement(motif: MotifDirection | null | undefined): string | null {
  if (!motif) return null;
  return libelleDirection(motif).slice(0, 40);
}

/** Commandes attendues, telles qu'écrites dans `Course.commandes_attendues`. */
export interface CommandeAttendueEcrite {
  order_id: string;
  reference: string;
  prete_vers: string;
  prete_au_plus_tard: string;
}

export function commandesAttenduesAEcrire(attendues: readonly CommandeAttendue[]): CommandeAttendueEcrite[] {
  return attendues.map((a) => ({
    order_id: a.order_id,
    reference: a.reference,
    prete_vers: a.prete_vers.toISOString(),
    prete_au_plus_tard: a.prete_au_plus_tard.toISOString(),
  }));
}

/** Identifiants des commandes attendues, depuis la colonne JSON (tolère null et formes inattendues). */
export function lireCommandesAttendues(valeur: unknown): string[] {
  if (!Array.isArray(valeur)) return [];
  return valeur
    .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { order_id?: unknown }).order_id : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Références des commandes attendues, depuis la colonne JSON (pour la notification du livreur). */
export function referencesAttendues(valeur: unknown): string[] {
  if (!Array.isArray(valeur)) return [];
  return valeur
    .map((v) => (v && typeof v === 'object' ? (v as { reference?: unknown }).reference : null))
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
}

// ─── Textes vus par le livreur (courts, tutoiement, chiffres) ───────────────

/** « 12 h 34 » (heure d'Abidjan = UTC). */
export function heureCourte(date: Date): string {
  return `${date.getUTCHours()} h ${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export interface TexteNotification {
  titre: string;
  corps: string;
}

const commandes = (n: number) => `${n} commande${n > 1 ? 's' : ''}`;

/**
 * Commande(s) ajoutée(s) à la course : « Commande ajoutée », puis le nombre
 * de commandes à prendre (avant le retrait) ou le code à redonner au
 * comptoir (après le retrait, même code).
 */
export function texteCommandeAjoutee(p: { ajoutees: number; total: number; apresRetrait: boolean; code: string }): TexteNotification {
  const titre = p.ajoutees > 1 ? `${p.ajoutees} commandes ajoutées` : 'Commande ajoutée';
  if (p.apresRetrait) return { titre, corps: `Code ${p.code} au comptoir` };
  return { titre, corps: `${commandes(p.total)} à prendre` };
}

/** Commande ajoutée après le retrait, pas remise : retirée au départ. */
export function texteCommandeRetiree(p: { reference: string; restantes: number }): TexteNotification {
  return { titre: 'Commande retirée', corps: `${commandes(p.restantes)} à livrer` };
}

/** Départ retenu : attendre une commande encore en cuisine. */
export function texteRetenue(p: { jusqua: Date; maintenant: Date }): TexteNotification {
  const minutes = Math.max(1, Math.ceil((p.jusqua.getTime() - p.maintenant.getTime()) / 60_000));
  return { titre: `Attends ${minutes} min`, corps: `Départ ${heureCourte(p.jusqua)}` };
}

/** Plus rien à attendre : le nombre de commandes à prendre et le code. */
export function texteToutEstPret(p: { code: string; total?: number }): TexteNotification {
  return { titre: 'Tout est prêt', corps: p.total ? `${commandes(p.total)} · code ${p.code}` : `Code ${p.code}` };
}

/** Commande ajoutée remise avec le même code : partir. */
export function texteCommandeRemise(): TexteNotification {
  return { titre: 'Tout est récupéré', corps: 'Tu peux partir' };
}

/** Une levée de retenue qui mérite d'être dite au livreur (encore au comptoir, pas parti). */
export function liberationAAnnoncer(motif: MotifLiberation): boolean {
  return motif === 'TOUT_PRET' || motif === 'ECHEANCE' || motif === 'PLUS_RIEN_A_ATTENDRE';
}
