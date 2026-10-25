/**
 * SUIVI DE LA LIVRAISON D'UNE COMMANDE, règle pure (demande du 24/10).
 *
 * Section « Livraison » du tiroir de détail d'une commande au back office
 * (`GET /orders/:id/livraison`) : qui livre, où il en est, et une frise des
 * étapes avec leur heure et la durée entre deux étapes.
 *
 * Réponse :
 *  - `service` : CHICKEN_NATION, TURBO, ou `null` (commande à emporter ou sur
 *    place, ancienne commande sans flotte) ;
 *  - `course` : la course en cours de la commande (référence, code de
 *    retrait, nombre de commandes, rang de l'arrêt de cette commande) ;
 *  - `livreur` : nom, téléphone et `etat`, clé simple traduite par l'écran.
 *    Présent dès qu'il y a une course, même sans livreur : `nom` nul en
 *    recherche, livreur sollicité (sans téléphone) quand l'offre attend sa
 *    réponse. Pour Turbo, le livreur que Turbo a annoncé, `nom` nul s'il ne
 *    l'a pas encore fait ;
 *  - `etapes` : acceptée, arrivée au restaurant, récupérée, départ, arrivée
 *    chez le client, livrée, dans cet ordre ;
 *  - `durees` : en secondes, entre les heures données par `etapes`.
 *
 * AUCUNE DONNÉE INVENTÉE :
 *  - une étape franchie dont l'heure n'a pas été notée (arrivée d'un livreur
 *    Turbo au restaurant, livreur qui n'a pas dit « Arrivé ») est omise ;
 *    une étape à venir est donnée sans heure, avec l'heure prévue quand le
 *    serveur la connaît déjà (`prevue`). Ainsi la première étape sans heure
 *    est toujours l'étape en cours ;
 *  - le départ n'est donné que s'il est réel (`Course.motif_depart`) et
 *    distinct de la récupération d'au moins une minute (course de plusieurs
 *    commandes, attente d'un sac), ou à venir avec son heure prévue : fin de
 *    la retenue annoncée au livreur (« Départ 12 h 41 »), sinon fin de la
 *    fenêtre d'ajout après le retrait, la même que l'écran Opérations ;
 *  - l'arrivée chez le client n'est prévue que pour le dernier arrêt d'une
 *    course partie : départ + durée de la tournée figée au retrait
 *    (`Course.estimated_duration_min`, restaurant vers tous les clients,
 *    arrêts compris). Les arrêts intermédiaires n'ont pas d'estimation ;
 *  - une durée n'existe que si ses deux heures existent, et n'est jamais
 *    négative.
 *
 * Tentative close sans livraison, commande toujours vivante (course expirée
 * ou annulée, livraison détachée ou annulée par Turbo) : la commande n'a plus
 * de livreur, la réponse est celle d'une commande sans course (« Pas encore
 * de livreur ») en attendant la suivante. Commande annulée, ou livraison en
 * échec : état `annulee`, avec ce qui s'était passé jusque là.
 *
 * Ajouts du 24/10 (conception, 11.3) :
 *  - `course.fin_prevue`, `course.en_retard`, `course.retard_min` : règle
 *    commune du retard (`retard-tournee.rules.ts`), comme les groupes « Hors
 *    restaurant » de l'écran Opérations ;
 *  - `tournee` : un arrêt par livraison non annulée de la course, dans
 *    l'ordre, avec la référence de sa commande, son état et l'heure de cet
 *    état. Aucune coordonnée ni aucun nom des autres clients ;
 *  - `echec` : motif et note du livreur quand la livraison de CETTE commande a
 *    échoué ;
 *  - `livreur.appli_active`, `appli_vue_a`, `appli_connectee` : appli du
 *    livreur Chicken Nation, comme la liste des livreurs (absents pour Turbo
 *    et sans livreur).
 *
 * Aucun appel Google, aucune lecture : tout vient de la commande lue par le
 * service (`SuiviLivraisonService`).
 */
import { DeliveryFailureReason } from '@prisma/client';

import {
  departEstReel,
  enRetard,
  finTourneePrevue,
  retardMin,
} from 'src/modules/course/helpers/retard-tournee.rules';

import {
  AppliOperations,
  ContexteTournee,
  CourseLue,
  FACTEUR_RETARD_DEFAUT,
  appliOperations,
  enrichirCourseOperations,
} from './suivi-operations.rules';

// ─── Réponse ─────────────────────────────────────────────────────────────────

export type ServiceLivraison = 'CHICKEN_NATION' | 'TURBO';

export type CleEtape = 'acceptee' | 'arrivee_restaurant' | 'recuperee' | 'depart' | 'arrivee_client' | 'livree';

export type EtatLivreur =
  | 'recherche'
  | 'proposee'
  | 'vers_restaurant'
  | 'au_comptoir'
  | 'vers_client'
  | 'livree'
  | 'annulee';

/** État d'un arrêt de la tournée, clé simple traduite par l'écran. */
export type EtatArret = 'a_livrer' | 'en_route' | 'chez_le_client' | 'livree' | 'echec';

export interface ArretTournee {
  /** Référence de la commande de cet arrêt. */
  reference: string;
  /** Rang dans la tournée (1 = premier client), livraisons annulées exclues. */
  rang: number;
  etat: EtatArret;
  /** Heure de cet état (ISO) : départ vers le client, arrivée, livraison ou échec ; `null` à livrer. */
  heure: string | null;
  /** L'arrêt de la commande ouverte. */
  cette_commande: boolean;
}

export interface EtapeLivraison {
  cle: CleEtape;
  /** Heure notée (ISO), `null` pour une étape à venir. */
  heure: string | null;
  /** Heure prévue (ISO) d'une étape à venir, quand le serveur la connaît. */
  prevue: string | null;
}

export interface SuiviLivraison {
  service: ServiceLivraison | null;
  course: {
    id: string;
    reference: string;
    code_retrait: string;
    /** Commandes de la course (livraisons annulées ou détachées exclues). */
    nombre_commandes: number;
    /** Rang de cet arrêt dans la tournée (1 = premier client), `null` si inconnu. */
    rang_arret: number | null;
    /** `Course.statut` (enum `CourseStatut`), pour information. */
    statut: string;
    /** Fin prévue de la tournée (ISO), `null` tant que le livreur n'est pas parti ou sans durée estimée. */
    fin_prevue: string | null;
    en_retard: boolean;
    /** Minutes pleines au-delà de la fin prévue ; `null` : pas en retard, ou en retard sans fin prévue. */
    retard_min: number | null;
  } | null;
  /**
   * Livreur ; `appli_active`, `appli_vue_a`, `appli_connectee` pour un livreur
   * Chicken Nation seulement (comme la liste des livreurs).
   */
  livreur: ({
    id: string | null;
    nom: string | null;
    telephone: string | null;
    etat: EtatLivreur;
  } & Partial<AppliOperations>) | null;
  /** Arrêts de la course (livraisons non annulées), vide sans course. */
  tournee: ArretTournee[];
  /** Échec de la livraison de CETTE commande : motif et note du livreur. */
  echec: { motif: DeliveryFailureReason | null; note: string | null } | null;
  etapes: EtapeLivraison[];
  durees: {
    vers_restaurant_s: number | null;
    attente_comptoir_s: number | null;
    vers_client_s: number | null;
    pret_a_livre_s: number | null;
  };
}

// ─── Ce qu'on lit ────────────────────────────────────────────────────────────

type DateLue = Date | string | null | undefined;

export interface PersonneLue {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export interface CourseLivraisonLue {
  id: string;
  reference: string;
  pickup_code: string;
  statut: string;
  assigned_at?: DateLue;
  at_restaurant_at?: DateLue;
  picked_up_at?: DateLue;
  parti_at?: DateLue;
  motif_depart?: string | null;
  estimated_duration_min?: number | null;
  delay_alerted_at?: DateLue;
  retenue_jusqua?: DateLue;
  deliverer?:
    | (PersonneLue & {
        phone?: string | null;
        last_location?: unknown;
        last_location_at?: DateLue;
        dernier_signal_at?: DateLue;
        protocole_appli?: number | null;
      })
    | null;
  /** Offre en attente la plus récente (`status` PENDING). */
  offer_attempts?: { expires_at: DateLue; deliverer?: PersonneLue | null }[] | null;
  /** Toutes les livraisons de la course, avec la référence et le statut de leur commande. */
  deliveries?:
    | {
        id: string;
        statut: string;
        sequence_order: number;
        in_route_at?: DateLue;
        arrived_at?: DateLue;
        delivered_at?: DateLue;
        failed_at?: DateLue;
        order?: { reference?: string | null; status?: string | null } | null;
      }[]
    | null;
}

export interface CommandeLivraisonLue {
  type: string;
  status: string;
  delivery_service?: string | null;
  ready_at?: DateLue;
  picked_up_at?: DateLue;
  collected_at?: DateLue;
  restaurant?: { latitude?: number | null; longitude?: number | null } | null;
  delivery?: {
    id: string;
    statut: string;
    arrived_at?: DateLue;
    delivered_at?: DateLue;
    failure_reason?: DeliveryFailureReason | null;
    failure_note?: string | null;
    turbo_courier_id?: string | null;
    turbo_courier_name?: string | null;
    turbo_courier_phone?: string | null;
    course?: CourseLivraisonLue | null;
  } | null;
}

export interface ContexteSuiviLivraison extends ContexteTournee {
  maintenant: Date;
  /** `course.ajout_apres_retrait_max_s` (0 : fenêtre coupée). */
  fenetreMaxS?: number;
  /** `course.depart_rayon_m`. */
  departRayonM?: number;
}

// ─── Règle ───────────────────────────────────────────────────────────────────

const ORDRE_ETAPES: CleEtape[] = ['acceptee', 'arrivee_restaurant', 'recuperee', 'depart', 'arrivee_client', 'livree'];

/** Commande sortie du restaurant (même liste que `STATUTS_COMMANDE_REMISE`). */
const STATUTS_RECUPEREE = ['PICKED_UP', 'COLLECTED', 'COMPLETED'];
/** Commande remise au client. */
const STATUTS_LIVREE = ['COLLECTED', 'COMPLETED'];
/** Écart minimal entre récupération et départ pour donner le départ à part. */
const DEPART_DISTINCT_MS = 60_000;

const SANS_DUREE: SuiviLivraison['durees'] = {
  vers_restaurant_s: null,
  attente_comptoir_s: null,
  vers_client_s: null,
  pret_a_livre_s: null,
};

const date = (v: DateLue): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Secondes de `a` à `b`, `null` si l'une manque ou si l'écart est négatif. */
const ecartS = (a: Date | null, b: Date | null): number | null => {
  if (!a || !b) return null;
  const ms = b.getTime() - a.getTime();
  return ms >= 0 ? Math.round(ms / 1000) : null;
};

const nomComplet = (p: PersonneLue | null | undefined): string | null => {
  const nom = [p?.first_name?.trim(), p?.last_name?.trim()].filter(Boolean).join(' ');
  return nom || null;
};

const texte = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
};

function serviceDe(c: CommandeLivraisonLue): ServiceLivraison | null {
  if (c.type !== 'DELIVERY') return null;
  if (c.delivery_service === 'TURBO') return 'TURBO';
  if (c.delivery_service === 'CHICKEN_NATION') return 'CHICKEN_NATION';
  // Ancienne valeur (FREE) : une course existe, c'est la flotte interne.
  return c.delivery?.course ? 'CHICKEN_NATION' : null;
}

const vide = (service: ServiceLivraison | null): SuiviLivraison => ({
  service,
  course: null,
  livreur: null,
  tournee: [],
  echec: null,
  etapes: [],
  durees: { ...SANS_DUREE },
});

/** État d'un arrêt d'après le statut de sa livraison. */
const ETAT_ARRET: Record<string, EtatArret> = {
  PENDING: 'a_livrer',
  IN_ROUTE: 'en_route',
  ARRIVED: 'chez_le_client',
  DELIVERED: 'livree',
  FAILED: 'echec',
};

/**
 * Arrêts de la tournée : livraisons non annulées, dans l'ordre. Seulement la
 * référence et l'état de chaque commande : rien des autres clients.
 */
export function arretsTournee(
  livraisons: NonNullable<CourseLivraisonLue['deliveries']>,
  livraisonId: string,
): ArretTournee[] {
  return livraisons
    .filter((l) => l.statut !== 'CANCELLED')
    .sort((a, b) => a.sequence_order - b.sequence_order)
    .map((l, i) => {
      const etat = ETAT_ARRET[l.statut] ?? 'a_livrer';
      const heure =
        etat === 'livree'
          ? l.delivered_at
          : etat === 'echec'
            ? l.failed_at
            : etat === 'chez_le_client'
              ? l.arrived_at
              : etat === 'en_route'
                ? l.in_route_at
                : null;
      return {
        reference: texte(l.order?.reference) ?? '',
        rang: i + 1,
        etat,
        heure: iso(date(heure)),
        cette_commande: l.id === livraisonId,
      };
    });
}

/**
 * Étapes dans l'ordre : heure notée, sinon étape à venir (avec son heure
 * prévue). Une étape franchie sans heure notée est omise, une étape à venir
 * aussi quand la livraison est annulée.
 */
function construireEtapes(p: {
  heures: Record<CleEtape, Date | null>;
  prevues: Partial<Record<CleEtape, Date | null>>;
  avancement: number;
  annulee: boolean;
  departDonne: boolean;
}): EtapeLivraison[] {
  const etapes: EtapeLivraison[] = [];
  ORDRE_ETAPES.forEach((cle, rang) => {
    if (cle === 'depart' && !p.departDonne) return;
    const heure = p.heures[cle];
    if (heure) {
      etapes.push({ cle, heure: iso(heure), prevue: null });
      return;
    }
    if (p.annulee || rang < p.avancement) return;
    etapes.push({ cle, heure: null, prevue: iso(p.prevues[cle] ?? null) });
  });
  return etapes;
}

function etatDe(avancement: number, annulee: boolean, offre: boolean): EtatLivreur {
  if (annulee) return 'annulee';
  if (avancement >= 6) return 'livree';
  if (avancement >= 4) return 'vers_client';
  if (avancement >= 2) return 'au_comptoir';
  if (avancement === 1) return 'vers_restaurant';
  return offre ? 'proposee' : 'recherche';
}

/** Durées entre les heures données (départ : seulement s'il est donné à part). */
function durees(heures: Record<CleEtape, Date | null>, pretA: Date | null): SuiviLivraison['durees'] {
  return {
    vers_restaurant_s: ecartS(heures.acceptee, heures.arrivee_restaurant),
    attente_comptoir_s: ecartS(heures.arrivee_restaurant, heures.recuperee),
    vers_client_s: ecartS(heures.depart ?? heures.recuperee, heures.arrivee_client),
    pret_a_livre_s: ecartS(pretA, heures.livree),
  };
}

/**
 * Commande confiée à Turbo sans course chez nous (envoi direct par le
 * personnel) : seuls les statuts de la commande sont connus.
 */
function suiviTurboDirect(c: CommandeLivraisonLue): SuiviLivraison {
  const annulee = c.status === 'CANCELLED';
  const recuperee = STATUTS_RECUPEREE.includes(c.status);
  const livree = STATUTS_LIVREE.includes(c.status);
  const heures: Record<CleEtape, Date | null> = {
    acceptee: null,
    arrivee_restaurant: null,
    recuperee: date(c.picked_up_at),
    depart: null,
    arrivee_client: null,
    livree: livree ? date(c.collected_at) : null,
  };
  // Rien de su avant la récupération : pas encore de livreur (annulée comprise).
  if (!recuperee && !heures.recuperee) return vide('TURBO');

  const avancement = livree ? 6 : recuperee ? 4 : 0;
  return {
    service: 'TURBO',
    course: null,
    livreur: { id: null, nom: null, telephone: null, etat: etatDe(avancement, annulee, false) },
    tournee: [],
    echec: null,
    etapes: construireEtapes({ heures, prevues: {}, avancement, annulee, departDonne: false }),
    durees: durees(heures, date(c.ready_at)),
  };
}

export function suiviLivraison(c: CommandeLivraisonLue, ctx: ContexteSuiviLivraison): SuiviLivraison {
  const service = serviceDe(c);
  if (!service) return vide(null);

  const livraison = c.delivery ?? null;
  const course = livraison?.course ?? null;
  const turbo = service === 'TURBO';
  if (!livraison || !course) return turbo ? suiviTurboDirect(c) : vide(service);

  const livreeParLaCommande = STATUTS_LIVREE.includes(c.status);
  const livree = livraison.statut === 'DELIVERED' || livreeParLaCommande;
  const annulee = c.status === 'CANCELLED' || livraison.statut === 'FAILED';

  // Tentative close sans livraison, commande vivante : plus de livreur, une
  // nouvelle course viendra (détachement, expiration, annulation par Turbo).
  if (
    !annulee &&
    !livree &&
    (livraison.statut === 'CANCELLED' || course.statut === 'CANCELLED' || course.statut === 'EXPIRED')
  ) {
    return vide(service);
  }

  // ── Où en est la livraison de CETTE commande ──
  const statut = course.statut;
  let avancement = 0;
  if (statut === 'ACCEPTED') avancement = 1;
  else if (statut === 'AT_RESTAURANT' || statut === 'IN_DELIVERY' || statut === 'COMPLETED') avancement = 2;
  const recuperee = !!date(c.picked_up_at) || STATUTS_RECUPEREE.includes(c.status);
  if (recuperee) avancement = Math.max(avancement, 3);
  // Turbo : récupérée = partie (la tournée démarre). Interne : départ noté.
  const partie = turbo || !!date(course.parti_at);
  if (recuperee && partie) avancement = Math.max(avancement, 4);
  if (livraison.statut === 'IN_ROUTE') avancement = Math.max(avancement, 4);
  if (livraison.statut === 'ARRIVED') avancement = Math.max(avancement, 5);
  if (livree) avancement = 6;

  // ── Heures notées ──
  const retraitCourse = date(course.picked_up_at);
  const heureRecuperee = date(c.picked_up_at) ?? (STATUTS_RECUPEREE.includes(c.status) ? retraitCourse : null);
  const parti = date(course.parti_at);
  // Départ réel : motif du serveur ; sans motif (course d'avant le motif), un
  // départ noté après la validation du retrait. Règle commune du retard.
  const departReel = departEstReel(course);
  const departDistinct =
    departReel && (!heureRecuperee || parti!.getTime() - heureRecuperee.getTime() >= DEPART_DISTINCT_MS);

  const heures: Record<CleEtape, Date | null> = {
    acceptee: date(course.assigned_at),
    arrivee_restaurant: date(course.at_restaurant_at),
    recuperee: heureRecuperee,
    depart: departDistinct ? parti : null,
    arrivee_client: date(livraison.arrived_at),
    livree: date(livraison.delivered_at) ?? (livreeParLaCommande ? date(c.collected_at) : null),
  };

  // ── Heures prévues (étapes à venir) ──
  const prevues: Partial<Record<CleEtape, Date | null>> = {};
  if (!turbo && !annulee && !parti) {
    const retenue = date(course.retenue_jusqua);
    if (retenue && retenue.getTime() > ctx.maintenant.getTime()) {
      prevues.depart = retenue;
    } else {
      prevues.depart = date(fenetreAjout(c, course, ctx));
    }
  }

  const actives = (course.deliveries ?? [])
    .filter((l) => l.statut !== 'CANCELLED')
    .sort((a, b) => a.sequence_order - b.sequence_order);
  const rang = actives.findIndex((l) => l.id === livraison.id);
  const rangArret = rang >= 0 ? rang + 1 : null;

  // Dernier arrêt d'une course partie : fin prévue de la tournée (départ +
  // durée estimée), la même que celle des écrans de suivi.
  const finTournee = finTourneePrevue(course);
  if (!annulee && finTournee && rangArret !== null && rangArret === actives.length) {
    prevues.arrivee_client = finTournee;
  }

  const departDonne = departDistinct || (!heures.depart && !parti && !!prevues.depart);

  // ── Livreur ──
  const echeanceOffre = date(course.offer_attempts?.[0]?.expires_at);
  const offre =
    !turbo &&
    statut === 'PENDING_ASSIGNMENT' &&
    !course.deliverer &&
    !!echeanceOffre &&
    echeanceOffre.getTime() > ctx.maintenant.getTime()
      ? course.offer_attempts![0].deliverer ?? null
      : null;
  const etat = etatDe(avancement, annulee, !!offre);

  let livreur: NonNullable<SuiviLivraison['livreur']>;
  if (turbo) {
    livreur = {
      id: texte(livraison.turbo_courier_id),
      nom: texte(livraison.turbo_courier_name),
      telephone: texte(livraison.turbo_courier_phone),
      etat,
    };
  } else if (course.deliverer) {
    livreur = {
      id: course.deliverer.id ?? null,
      nom: nomComplet(course.deliverer),
      telephone: texte(course.deliverer.phone),
      etat,
      ...(ctx.appli
        ? appliOperations(
            {
              id: course.deliverer.id,
              dernier_signal_at: course.deliverer.dernier_signal_at,
              protocole_appli: course.deliverer.protocole_appli,
            },
            ctx.maintenant,
            ctx.appli,
          )
        : {}),
    };
  } else if (offre && etat === 'proposee') {
    // Sollicité, pas encore engagé : son nom, pas son téléphone.
    livreur = { id: offre.id ?? null, nom: nomComplet(offre), telephone: null, etat };
  } else {
    livreur = { id: null, nom: null, telephone: null, etat };
  }

  const facteur = ctx.facteurRetard ?? FACTEUR_RETARD_DEFAUT;
  const echec =
    livraison.statut === 'FAILED'
      ? { motif: livraison.failure_reason ?? null, note: texte(livraison.failure_note) }
      : null;

  return {
    service,
    course: {
      id: course.id,
      reference: course.reference,
      code_retrait: course.pickup_code,
      nombre_commandes: actives.length,
      rang_arret: rangArret,
      statut: course.statut,
      fin_prevue: iso(finTournee),
      en_retard: enRetard(course, ctx.maintenant, facteur),
      retard_min: retardMin(course, ctx.maintenant, facteur),
    },
    livreur,
    tournee: arretsTournee(course.deliveries ?? [], livraison.id),
    echec,
    etapes: construireEtapes({ heures, prevues, avancement, annulee, departDonne }),
    durees: durees(heures, date(c.ready_at)),
  };
}

/**
 * Fin de la fenêtre d'ajout après le retrait, calculée comme pour l'écran
 * Opérations (`enrichirCourseOperations`), prolongation pour un sac attendu
 * comprise : une commande de la course encore prête au comptoir.
 */
function fenetreAjout(c: CommandeLivraisonLue, course: CourseLivraisonLue, ctx: ContexteSuiviLivraison): string | null {
  if (!ctx.fenetreMaxS) return null;
  const sacAttendu = (course.deliveries ?? []).some((l) => l.statut === 'PENDING' && l.order?.status === 'READY');
  const r = c.restaurant;
  const restaurant =
    r && typeof r.latitude === 'number' && typeof r.longitude === 'number' ? { lat: r.latitude, lng: r.longitude } : null;
  const lue: CourseLue = {
    id: course.id,
    statut: course.statut,
    picked_up_at: course.picked_up_at ?? null,
    parti_at: course.parti_at ?? null,
    retenue_jusqua: course.retenue_jusqua ?? null,
    offer_attempts: null,
    deliverer: course.deliverer
      ? { last_location: course.deliverer.last_location, last_location_at: course.deliverer.last_location_at ?? null }
      : null,
  };
  return enrichirCourseOperations(lue, {
    maintenant: ctx.maintenant,
    fenetreMaxS: ctx.fenetreMaxS,
    sacsAttendus: sacAttendu ? new Set([course.id]) : new Set<string>(),
    restaurant,
    departRayonM: ctx.departRayonM,
  }).fenetre_ajout_ferme_a;
}
