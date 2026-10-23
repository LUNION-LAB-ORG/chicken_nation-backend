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
 *    pose `parti_at` à cette échéance au plus tard (passage de 10 s), sauf
 *    quand la course attend encore son sac : une commande de la course reste
 *    à remettre et le livreur est encore au comptoir. La fin
 *    donnée est alors celle de cette prolongation (2 min au plus, même règle
 *    que le planificateur, `attendSonSac`) : l'écran ne passe pas la course
 *    « partie » avant le serveur.
 */
import { attendSonSac, PROLONGATION_REMISE_S } from 'src/modules/course/helpers/planification.rules';

export interface OffreLue {
  expires_at: Date | string;
  deliverer?: { first_name?: string | null } | null;
}

export interface CourseLue {
  id?: string | null;
  statut?: string | null;
  picked_up_at?: Date | string | null;
  parti_at?: Date | string | null;
  offer_attempts?: OffreLue[] | null;
  deliverer?: { last_location?: unknown; last_location_at?: Date | string | null } | null;
  [cle: string]: unknown;
}

/** Ce que la prolongation de la fenêtre lit en plus (liste des commandes, réglages). */
export interface ContexteFenetre {
  /** Courses dont une commande reste à remettre (ajoutée après le retrait ou d'origine). */
  sacsAttendus?: ReadonlySet<string>;
  /** Restaurant de la commande lue (coordonnées). */
  restaurant?: { lat: number; lng: number } | null;
  /** `course.depart_rayon_m`. */
  departRayonM?: number;
}

const date = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const point = (v: unknown): { lat: number; lng: number } | null => {
  const p = v as { lat?: unknown; lng?: unknown } | null | undefined;
  return p && typeof p.lat === 'number' && typeof p.lng === 'number' ? { lat: p.lat, lng: p.lng } : null;
};

export function enrichirCourseOperations<T extends CourseLue>(
  course: T,
  p: { maintenant: Date; fenetreMaxS: number } & ContexteFenetre,
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
    const fermeA = retrait.getTime() + p.fenetreMaxS * 1000;
    const prolongee =
      p.departRayonM !== undefined &&
      attendSonSac({
        fermeAMs: fermeA,
        maintenant: p.maintenant,
        sacAttendu: !!course.id && !!p.sacsAttendus?.has(course.id),
        position: point(course.deliverer?.last_location),
        position_at: date(course.deliverer?.last_location_at),
        restaurant: p.restaurant ?? null,
        departRayonM: p.departRayonM,
      });
    fenetre_ajout_ferme_a = new Date(fermeA + (prolongee ? PROLONGATION_REMISE_S * 1000 : 0)).toISOString();
  }

  return { ...reste, offre_en_cours, fenetre_ajout_ferme_a };
}

interface LivraisonLue {
  course_id?: string | null;
  statut?: string | null;
  ajoutee_apres_retrait?: boolean | null;
  course?: CourseLue | null;
}

/** Livraison d'une commande de la liste, telle que lue (ou `null`). */
const livraisonDe = (c: object): LivraisonLue | null => {
  const l = (c as { delivery?: unknown }).delivery;
  return l && typeof l === 'object' ? (l as LivraisonLue) : null;
};

/**
 * Courses dont une commande est prête et pas encore remise (livraison en
 * attente), ajoutée après le retrait ou d'origine (remise une par une au
 * bouton de la caisse) : elles attendent leur sac (même règle que le
 * planificateur, `estSacAuComptoir`).
 */
export function coursesQuiAttendentUnSac(commandes: readonly object[]): Set<string> {
  const res = new Set<string>();
  for (const c of commandes) {
    const l = livraisonDe(c);
    const courseId = l?.course_id ?? l?.course?.id ?? null;
    if (!courseId || l?.statut !== 'PENDING') continue;
    if ((c as { status?: unknown }).status === 'READY') res.add(courseId);
  }
  return res;
}

/** Applique l'enrichissement à la course de chaque commande (commandes sans course inchangées). */
export function enrichirCommandesOperations<C extends object>(
  commandes: C[],
  p: { maintenant: Date; fenetreMaxS: number; departRayonM?: number },
): C[] {
  const sacsAttendus = coursesQuiAttendentUnSac(commandes);
  return commandes.map((c) => {
    const livraison = livraisonDe(c);
    if (!livraison || !livraison.course) return c;
    const r = (c as { restaurant?: { latitude?: unknown; longitude?: unknown } | null }).restaurant;
    const restaurant =
      r && typeof r.latitude === 'number' && typeof r.longitude === 'number' ? { lat: r.latitude, lng: r.longitude } : null;
    return {
      ...c,
      delivery: { ...livraison, course: enrichirCourseOperations(livraison.course, { ...p, sacsAttendus, restaurant }) },
    };
  });
}
