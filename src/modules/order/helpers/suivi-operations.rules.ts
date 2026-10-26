/**
 * ÉCRAN OPÉRATIONS : ce que le serveur ajoute à chaque course de
 * `GET /orders/operations/active`, règle pure (demande du backoffice, 23/10).
 *
 *  - `offre_en_cours { prenom, expires_at }` : course proposée à un livreur,
 *    « Proposée à Koffi, réponse avant 12 h 36 ». L'offre en attente lue en
 *    base (`offer_attempts`) est retirée de la réponse ;
 *  - `fenetre_ajout_ferme_a` : course récupérée, livreur pas encore parti
 *    (`parti_at` nul) : fin de la fenêtre d'ajout après le retrait
 *    (`picked_up_at` + `course.ajout_apres_retrait_max_s`, comptée depuis la
 *    fin de la retenue si elle finit après le retrait, comme le serveur :
 *    `debutFenetreApresRetraitMs`, 25/10). Le planificateur
 *    pose `parti_at` à cette échéance au plus tard (passage de 10 s), sauf
 *    quand la course attend encore son sac : une commande de la course reste
 *    à remettre et le livreur est encore au comptoir. La fin
 *    donnée est alors celle de cette prolongation (2 min au plus, même règle
 *    que le planificateur, `attendSonSac`) : l'écran ne passe pas la course
 *    « partie » avant le serveur.
 *
 * Ajouts du 24/10 (conception, 11.2), pour les groupes « Hors restaurant »
 * et l'état du livreur sur le groupe d'une course :
 *  - `tournee { total, livrees, fin_prevue, en_retard, retard_min }` : total
 *    = livraisons non annulées, livrées = DELIVERED, le reste par la règle
 *    commune du retard (`retard-tournee.rules.ts`). Les livraisons lues pour
 *    la compter sont retirées de la réponse ;
 *  - `deliverer.appli_active`, `appli_vue_a`, `appli_connectee` : calculés
 *    comme pour la liste des livreurs (règle unique de l'appli fermée). Le
 *    dernier signe de vie et le protocole lus pour les calculer sont retirés ;
 *  - `deliverer.appli_etat` (25/10) : ACTIVE, FERMEE (fermée par le livreur,
 *    prouvé par la fin de son socket) ou COUPURE (connexion coupée).
 */
import { enRetard, finTourneePrevue, retardMin } from 'src/modules/course/helpers/retard-tournee.rules';
import { attendSonSac, debutFenetreApresRetraitMs, PROLONGATION_REMISE_S } from 'src/modules/course/helpers/planification.rules';
import {
  APPLI_FERMEE_APRES_S_DEFAUT,
  EtatAppli,
  FinSocket,
  appliActiveDepuis,
  etatAppliDepuis,
  regleAppliPour,
} from 'src/modules/deliverers/helpers/disponibilite.rules';
import { lirePositionLivreur } from 'src/modules/deliverers/helpers/position-livreur.rules';

export interface OffreLue {
  expires_at: Date | string;
  deliverer?: { first_name?: string | null } | null;
}

type DateLue = Date | string | null | undefined;

/** Livreur de la course, tel que lu (signe de vie et protocole : appli du livreur). */
export interface LivreurLu {
  id?: string | null;
  last_location?: unknown;
  last_location_at?: DateLue;
  dernier_signal_at?: DateLue;
  protocole_appli?: number | null;
  [cle: string]: unknown;
}

export interface CourseLue {
  id?: string | null;
  statut?: string | null;
  picked_up_at?: DateLue;
  parti_at?: DateLue;
  /** Fin de la retenue au comptoir (en cours, ou heure de sa levée). */
  retenue_jusqua?: DateLue;
  motif_depart?: string | null;
  estimated_duration_min?: number | null;
  delay_alerted_at?: DateLue;
  offer_attempts?: OffreLue[] | null;
  /** Statut de chaque livraison de la course : la tournée (« 1 sur 3 livrée »). */
  deliveries?: { statut?: string | null }[] | null;
  deliverer?: LivreurLu | null;
  [cle: string]: unknown;
}

/** Tournée d'une course (groupes « Hors restaurant »). */
export interface TourneeOperations {
  /** Livraisons non annulées. */
  total: number;
  /** Livraisons DELIVERED. */
  livrees: number;
  /** Fin prévue de la tournée (ISO), `null` tant que le livreur n'est pas parti ou sans durée estimée. */
  fin_prevue: string | null;
  en_retard: boolean;
  /** Minutes pleines au-delà de la fin prévue ; `null` : pas en retard, ou en retard sans fin prévue. */
  retard_min: number | null;
}

/** Appli du livreur, comme dans la liste des livreurs. */
export interface AppliOperations {
  /** Socket ouvert ou signe de vie récent ; faux : « Appli fermée » ; null : règle coupée ou ancienne appli. */
  appli_active: boolean | null;
  /** Dernier signe de vie (ISO), null si jamais vu. */
  appli_vue_a: string | null;
  /** Socket ouvert ; faux avec une appli active : « En arrière-plan » ; null : présence inconnue. */
  appli_connectee: boolean | null;
  /**
   * ACTIVE ; FERMEE : « Appli fermée » (le livreur l'a fermée, prouvé) ;
   * COUPURE : « Connexion coupée » (tout autre silence) ; null : règle coupée
   * ou ancienne appli.
   */
  appli_etat: EtatAppli | null;
}

/** Réglage `course.delay_alert_factor`. */
export const CLE_FACTEUR_RETARD = 'course.delay_alert_factor';
/** Défaut de `course.delay_alert_factor` (`CourseSettingsHelper`). */
export const FACTEUR_RETARD_DEFAUT = 1.5;
/** Réglage `deliverer.appli_fermee_apres_s`. */
export const CLE_APPLI_FERMEE_APRES_S = 'deliverer.appli_fermee_apres_s';

/** Lecture du facteur de retard, comme `CourseSettingsHelper` : vide, illisible ou pas positif, défaut. */
export function lireFacteurRetard(brut: string | undefined): number {
  if (brut === undefined || brut === '') return FACTEUR_RETARD_DEFAUT;
  const n = Number(brut);
  return Number.isFinite(n) && n > 0 ? n : FACTEUR_RETARD_DEFAUT;
}

/** Lecture du seuil de l'appli fermée, comme `DelivererScoringSettingsHelper` : 0 coupe la règle. */
export function lireAppliFermeeApresS(brut: string | undefined): number {
  if (brut === undefined || brut === '') return APPLI_FERMEE_APRES_S_DEFAUT;
  const n = Number(brut);
  return Number.isFinite(n) ? n : APPLI_FERMEE_APRES_S_DEFAUT;
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

/** Ce que la tournée et l'appli du livreur lisent en plus. */
export interface ContexteTournee {
  /** `course.delay_alert_factor` ; défaut 1,5. */
  facteurRetard?: number;
  /**
   * `deliverer.appli_fermee_apres_s` (défaut 180, 0 : règle coupée), sockets
   * ouverts parmi les livreurs de la liste (`null` : présence inconnue) et fin
   * du dernier socket des autres (`finsSocket` ; absent ou null : aucune
   * preuve, jamais « Appli fermée »).
   */
  appli?: {
    appliFermeeApresS: number;
    connectes: ReadonlySet<string> | null;
    finsSocket?: ReadonlyMap<string, FinSocket> | null;
  };
}

const date = (v: DateLue): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Tournée d'une course : livraisons comptées, fin prévue et retard par la règle commune. */
export function tourneeOperations(course: CourseLue, maintenant: Date, facteurRetard: number): TourneeOperations {
  const livraisons = course.deliveries ?? [];
  const fin = finTourneePrevue(course);
  return {
    total: livraisons.filter((l) => l.statut !== 'CANCELLED').length,
    livrees: livraisons.filter((l) => l.statut === 'DELIVERED').length,
    fin_prevue: fin ? fin.toISOString() : null,
    en_retard: enRetard(course, maintenant, facteurRetard),
    retard_min: retardMin(course, maintenant, facteurRetard),
  };
}

/**
 * Appli du livreur, comme la liste des livreurs (`DeliverersService.findAll`) :
 * jugée par la règle unique quand elle vise ce livreur (réglage au-dessus de
 * 0, appli au protocole 4 au moins), sinon `null`.
 */
export function appliOperations(
  livreur: LivreurLu,
  maintenant: Date,
  appli: NonNullable<ContexteTournee['appli']>,
): AppliOperations {
  const id = livreur.id ?? '';
  const vue = date(livreur.dernier_signal_at);
  const protocole = livreur.protocole_appli ?? null;
  const ligne = { id, dernier_signal_at: vue, protocole_appli: protocole };
  return {
    appli_active: regleAppliPour(protocole, appli.appliFermeeApresS) ? appliActiveDepuis(ligne, appli, maintenant) : null,
    appli_vue_a: vue ? vue.toISOString() : null,
    appli_connectee: appli.connectes ? appli.connectes.has(id) : null,
    appli_etat: etatAppliDepuis(ligne, appli, maintenant),
  };
}

const SANS_PRESENCE = { appliFermeeApresS: APPLI_FERMEE_APRES_S_DEFAUT, connectes: null };

/** Course de la réponse : offre et livraisons lues retirées, livreur complété. */
export type CourseOperations<T extends CourseLue> = Omit<T, 'offer_attempts' | 'deliveries' | 'deliverer'> & {
  deliverer?: (Omit<NonNullable<T['deliverer']>, 'dernier_signal_at' | 'protocole_appli'> & AppliOperations) | null;
  offre_en_cours: { prenom: string | null; expires_at: string } | null;
  fenetre_ajout_ferme_a: string | null;
  tournee: TourneeOperations;
};

export function enrichirCourseOperations<T extends CourseLue>(
  course: T,
  p: { maintenant: Date; fenetreMaxS: number } & ContexteFenetre & ContexteTournee,
): CourseOperations<T> {
  const { offer_attempts, deliveries, ...reste } = course;

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
    // Depuis la fin de la retenue si elle finit après le retrait, comme le planificateur.
    const debut = debutFenetreApresRetraitMs({ picked_up_at: retrait, retenue_jusqua: date(course.retenue_jusqua) })!;
    const fermeA = debut + p.fenetreMaxS * 1000;
    // Dernière position PRÉCISE seulement, comme le planificateur.
    const sure = lirePositionLivreur(course.deliverer?.last_location, course.deliverer?.last_location_at ?? null).sure;
    const prolongee =
      p.departRayonM !== undefined &&
      attendSonSac({
        fermeAMs: fermeA,
        maintenant: p.maintenant,
        sacAttendu: !!course.id && !!p.sacsAttendus?.has(course.id),
        position: sure?.position ?? null,
        position_at: sure?.position_at ?? null,
        restaurant: p.restaurant ?? null,
        departRayonM: p.departRayonM,
      });
    fenetre_ajout_ferme_a = new Date(fermeA + (prolongee ? PROLONGATION_REMISE_S * 1000 : 0)).toISOString();
  }

  const tournee = tourneeOperations({ ...course, deliveries }, p.maintenant, p.facteurRetard ?? FACTEUR_RETARD_DEFAUT);

  const sortie: Record<string, unknown> = { ...reste, offre_en_cours, fenetre_ajout_ferme_a, tournee };
  // Livreur : état de son appli ; signe de vie et protocole lus pour le juger, retirés.
  const lu = course.deliverer;
  if (lu && typeof lu === 'object') {
    const { dernier_signal_at: _vue, protocole_appli: _protocole, ...livreur } = lu;
    sortie.deliverer = { ...livreur, ...appliOperations(lu, p.maintenant, p.appli ?? SANS_PRESENCE) };
  }
  return sortie as CourseOperations<T>;
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

/**
 * Livreurs des courses de la liste (sans doublon) : la présence de leur appli
 * est demandée une seule fois pour toute la liste.
 */
export function livreursDesCommandes(commandes: readonly object[]): string[] {
  const ids = new Set<string>();
  for (const c of commandes) {
    const id = livraisonDe(c)?.course?.deliverer?.id;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return [...ids];
}

/** Applique l'enrichissement à la course de chaque commande (commandes sans course inchangées). */
export function enrichirCommandesOperations<C extends object>(
  commandes: C[],
  p: { maintenant: Date; fenetreMaxS: number; departRayonM?: number } & ContexteTournee,
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
