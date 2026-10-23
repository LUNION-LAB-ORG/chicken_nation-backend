/**
 * ÉCRAN OPÉRATIONS : ce que le serveur ajoute à chaque course de
 * `GET /orders/operations/active`, règle pure (demande du backoffice, 23/10).
 *
 *  - `offre_en_cours { prenom, expires_at }` : course proposée à un livreur,
 *    « Proposée à Koffi, réponse avant 12 h 36 ». L'offre en attente lue en
 *    base (`offer_attempts`) est retirée de la réponse ;
 *  - `fenetre_ajout_ferme_a` : course récupérée, livreur pas encore parti
 *    (`parti_at` nul) : fin de la fenêtre d'ajout après le retrait
 *    (`picked_up_at` + `course.ajout_apres_retrait_max_s`). Le planificateur
 *    pose `parti_at` à cette échéance au plus tard (passage de 10 s).
 */

export interface OffreLue {
  expires_at: Date | string;
  deliverer?: { first_name?: string | null } | null;
}

export interface CourseLue {
  statut?: string | null;
  picked_up_at?: Date | string | null;
  parti_at?: Date | string | null;
  offer_attempts?: OffreLue[] | null;
  [cle: string]: unknown;
}

const date = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function enrichirCourseOperations<T extends CourseLue>(
  course: T,
  p: { maintenant: Date; fenetreMaxS: number },
): Omit<T, 'offer_attempts'> & {
  offre_en_cours: { prenom: string | null; expires_at: string } | null;
  fenetre_ajout_ferme_a: string | null;
} {
  const { offer_attempts, ...reste } = course;

  let offre_en_cours: { prenom: string | null; expires_at: string } | null = null;
  const offre = (offer_attempts ?? [])[0];
  const echeance = date(offre?.expires_at);
  if (course.statut === 'PENDING_ASSIGNMENT' && echeance && echeance.getTime() > p.maintenant.getTime()) {
    const prenom = offre?.deliverer?.first_name?.trim() || null;
    offre_en_cours = { prenom, expires_at: echeance.toISOString() };
  }

  let fenetre_ajout_ferme_a: string | null = null;
  const retrait = date(course.picked_up_at);
  if (course.statut === 'IN_DELIVERY' && retrait && !course.parti_at && p.fenetreMaxS > 0) {
    fenetre_ajout_ferme_a = new Date(retrait.getTime() + p.fenetreMaxS * 1000).toISOString();
  }

  return { ...reste, offre_en_cours, fenetre_ajout_ferme_a };
}

/** Applique l'enrichissement à la course de chaque commande (commandes sans course inchangées). */
export function enrichirCommandesOperations<C extends object>(
  commandes: C[],
  p: { maintenant: Date; fenetreMaxS: number },
): C[] {
  return commandes.map((c) => {
    const livraison = (c as { delivery?: unknown }).delivery as { course?: CourseLue | null } | null | undefined;
    if (!livraison || typeof livraison !== 'object' || !livraison.course) return c;
    return { ...c, delivery: { ...livraison, course: enrichirCourseOperations(livraison.course, p) } };
  });
}
