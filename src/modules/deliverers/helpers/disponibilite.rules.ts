import {
  CallStatus,
  CourseOfferStatus,
  CourseStatut,
  DelivererStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';

import {
  APPEL_FANTOME_MS,
  MARGE_SONNERIE_LIVREUR_MS,
  SONNERIE_LIVREUR_MS,
} from 'src/modules/calls/constants/calls.constants';

/**
 * DISPONIBILITÉ D'UN LIVREUR : peut-il recevoir une offre de course ?
 *
 * Demande du 22/10 : « Quand un livreur est en pause il ne doit pas recevoir
 * de commandes. » La pause enregistrée au serveur est la seule vérité, et
 * cette règle unique garde TOUTES les sources d'offre : sélection automatique
 * (filtre Prisma équivalent ci-dessous, test d'équivalence), relances,
 * expiration, affectation forcée par l'admin, acceptation, fusion et ajout de
 * commandes à une course.
 *
 * Un livreur peut recevoir une offre s'il est, à la fois :
 *  - actif et opérationnel (compte validé, restaurant affecté, non supprimé) ;
 *  - ni en pause, ni en pause automatique (sanction après des refus) ;
 *  - sans course acceptée, au restaurant ou en livraison ;
 *  - sans autre offre en attente : l'appli n'en affiche qu'une, et ferme
 *    l'offre affichée à la clôture de N'IMPORTE laquelle ;
 *  - en service : `last_available_at` non nul (il a touché « Reprendre » ou
 *    ouvert l'appli, et ne s'est ni mis en pause ni déconnecté depuis) ;
 *  - appli active (demande du 24/10 : « c'est lorsqu'il ferme la fenêtre que
 *    ça ne doit pas passer ») : au moins un socket ouvert, OU un signe de vie
 *    (position ou requête authentifiée, `dernier_signal_at`) de moins de
 *    `deliverer.appli_fermee_apres_s` secondes (défaut 180, 0 = règle
 *    coupée). En arrière-plan, l'appli envoie ses positions et reste active ;
 *    glissée hors de la liste des applis, elle se tait et le livreur ne
 *    reçoit plus rien jusqu'à sa réouverture, sans pause ni pénalité. Seule
 *    l'appli au protocole 4 au moins est visée : celle d'avant se tait en
 *    arrière-plan et garde ses offres par notification. Une appli qui se tait
 *    n'est dite FERMÉE (`APPLI_FERMEE`) que sur preuve : son dernier socket a
 *    été fermé par l'appli elle-même et rien n'est venu d'elle ensuite
 *    (`fermetureProuvee`). Tout autre silence (réseau coupé, téléphone qui
 *    gèle ou arrête l'appli, raison inconnue) est une CONNEXION COUPÉE
 *    (`CONNEXION_COUPEE`, retour du client du 25/10), avec les mêmes effets ;
 *  - joignable (défaut signalé le 24/10 : « la course est proposée au livreur
 *    pourtant le livreur ne reçoit rien ») : au moins un socket ouvert dans sa
 *    salle `deliverer_{id}`, OU un jeton de notification. Sans l'un ni
 *    l'autre, rien ne peut lui arriver : il est passé, comme s'il n'était pas
 *    disponible à ce moment, sans pause ni pénalité, et redevient candidat dès
 *    qu'il est joignable. iOS suspend le socket en arrière-plan : avec un
 *    jeton, le livreur reste joignable. Réglage
 *    `course.offre_joignables_seulement` (défaut 1, 0 = règle coupée).
 *    Présence inconnue (Redis ou l'autre serveur muet) : personne n'est
 *    réputé injoignable. Cette règle ne garde que la CRÉATION d'une offre
 *    (sélection, planificateur, affectation forcée) : les relances,
 *    l'échéance et l'acceptation d'une offre déjà partie n'en dépendent pas ;
 *  - pas en appel avec le service client (relecture du 24/10 : l'écran d'appel
 *    recouvre tout, une offre arrivée pendant l'appel restait cachée dessous
 *    jusqu'à son échéance, comptée comme un refus) : un appel qui sonne (moins
 *    de 60 s) ou en ligne (moins de 4 h, même fenêtre que
 *    `GET /calls/deliverer/active`). Il est passé, sans pause ni pénalité, et
 *    redevient candidat à la fin de l'appel (passage suivant du planificateur,
 *    5 s). Comme la joignabilité, cette règle ne garde que la CRÉATION d'une
 *    offre : relances, échéance et acceptation d'une offre déjà partie n'en
 *    dépendent pas. Appels illisibles : personne n'est réputé en appel.
 *
 * Le chaînage (offre pendant la dernière livraison) est suspendu : il aura sa
 * propre règle s'il revient (lot 9 de la conception).
 */

/** Pourquoi un livreur ne peut pas recevoir d'offre, par ordre de priorité. */
export type MotifRefusOffre =
  | 'INACTIF'
  | 'EN_PAUSE'
  | 'PAUSE_AUTO'
  | 'EN_COURSE'
  | 'OFFRE_EN_ATTENTE'
  | 'HORS_SERVICE'
  | 'APPLI_FERMEE'
  | 'CONNEXION_COUPEE'
  | 'INJOIGNABLE'
  | 'EN_APPEL';

export type DecisionOffre = { ok: true } | { ok: false; motif: MotifRefusOffre };

/** Ce que la règle lit d'un livreur. */
export interface EtatLivreur {
  status: DelivererStatus;
  is_operational: boolean;
  entity_status: EntityStatus;
  pause_until: Date | null;
  auto_pause_until: Date | null;
  last_available_at: Date | null;
  /** Au moins une course ACCEPTED, AT_RESTAURANT ou IN_DELIVERY. */
  en_course: boolean;
  /** Au moins une offre PENDING, échue ou non : tant que la tâche ne l'a pas traitée, elle compte. */
  offre_en_attente: boolean;
  /**
   * Appli active : socket ouvert ou signe de vie récent (`estAppliActive`).
   * Toujours vrai quand la règle est coupée (`deliverer.appli_fermee_apres_s` à 0).
   */
  appli_active: boolean;
  /**
   * L'appli a fermé elle-même son dernier socket et rien n'est venu d'elle
   * ensuite (`fermetureProuvee`). Lu seulement quand l'appli n'est pas
   * active : vrai, « Appli fermée » ; faux ou absent, « Connexion coupée ».
   */
  appli_fermee_prouvee?: boolean;
  /** Dernier signe de vie de l'appli (`dernier_signal_at`), pour l'affichage. */
  appli_vue_a?: Date | null;
  /**
   * Joignable : socket ouvert ou jeton de notification. Faux seulement quand
   * le serveur SAIT que rien ne peut lui arriver ; absent : non jugé (règle
   * coupée, jeton non lu, présence inconnue), réputé joignable.
   */
  joignable?: boolean;
  /**
   * En appel avec le service client (sonne ou en ligne). Absent : non jugé
   * (appels illisibles), réputé hors appel.
   */
  en_appel?: boolean;
}

/** Une course dont le livreur est occupé : ni offre, ni chaînage. */
export const STATUTS_COURSE_EN_COURS: CourseStatut[] = [
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];

/**
 * Pause « jusqu'à Reprendre » : bouton de pause sans durée, déconnexion, mise
 * hors service sans signal. Date lointaine plutôt qu'un champ de plus.
 */
export const FIN_PAUSE_INDEFINIE = new Date('2099-12-31T23:59:59Z');

/** Pause manuelle active (`pause_until` dans le futur). */
export function estEnPause(l: Pick<EtatLivreur, 'pause_until'>, maintenant: Date): boolean {
  return l.pause_until !== null && l.pause_until.getTime() > maintenant.getTime();
}

/** Pause automatique active (sanction après des refus répétés). */
export function estEnPauseAuto(
  l: Pick<EtatLivreur, 'auto_pause_until'>,
  maintenant: Date,
): boolean {
  return l.auto_pause_until !== null && l.auto_pause_until.getTime() > maintenant.getTime();
}

/** En service : dans la file, prêt à recevoir des offres. */
export function estEnService(l: Pick<EtatLivreur, 'last_available_at'>): boolean {
  return l.last_available_at !== null;
}

// ============================================================
// APPLI ACTIVE OU FERMÉE
// ============================================================

/** Défaut de `deliverer.appli_fermee_apres_s` : trois minutes sans socket ni signe de vie. */
export const APPLI_FERMEE_APRES_S_DEFAUT = 180;

/**
 * Protocole de l'appli qui garde son suivi en arrière-plan (en-tête
 * `x-deli-protocole`, 4 depuis l'OTA du 24/10). L'appli d'avant (3 ou moins,
 * ou jamais vue) se tait en arrière-plan : la règle de l'appli fermée ne la
 * vise pas, elle garde ses offres par notification, et son état est inconnu
 * à l'écran.
 */
export const PROTOCOLE_APPLI_FERMEE = 4;

/** La règle de l'appli fermée vise-t-elle ce livreur ? Réglage au-dessus de 0 et appli récente. */
export function regleAppliPour(protocoleAppli: number | null | undefined, appliFermeeApresS: number): boolean {
  return appliFermeeApresS > 0 && (protocoleAppli ?? 0) >= PROTOCOLE_APPLI_FERMEE;
}

/**
 * Ce qu'il faut savoir, en plus de la ligne du livreur, pour juger son appli.
 *
 * `connectes` : livreurs dont un socket est ouvert, parmi ceux dont la
 * présence a été demandée au serveur temps réel (ceux dont le signe de vie
 * ne suffit pas). `null` : présence inconnue (Redis muet), l'appli est alors
 * jugée sur son seul signe de vie.
 */
export interface ContexteAppli {
  /** Réglage `deliverer.appli_fermee_apres_s` ; 0 ou moins : règle coupée. */
  appliFermeeApresS: number;
  connectes: ReadonlySet<string> | null;
  /**
   * Livreurs INJOIGNABLES : ni socket ouvert ni jeton de notification, parmi
   * ceux dont le jeton a été lu (`injoignablesParmi`). Absent ou null : règle
   * coupée (`course.offre_joignables_seulement` à 0), jetons non lus ou
   * présence inconnue ; personne n'est alors réputé injoignable.
   */
  injoignables?: ReadonlySet<string> | null;
  /**
   * Livreurs EN APPEL avec le service client (`livreursEnAppel`). Absent ou
   * vide : personne n'est réputé en appel.
   */
  enAppel?: ReadonlySet<string> | null;
  /**
   * Fin du dernier socket des livreurs sans socket ouvert
   * (`FinsSocketLivreursService`). Absent ou null : fins non lues ou Redis
   * muet, aucune preuve, donc jamais « Appli fermée ».
   */
  finsSocket?: ReadonlyMap<string, FinSocket> | null;
}

// ============================================================
// APPLI FERMÉE PAR LE LIVREUR OU CONNEXION COUPÉE (25/10)
// ============================================================

/** Fin du dernier socket du livreur (FinsSocketLivreursService) : raison socket.io et heure. */
export interface FinSocket {
  raison: string;
  a: Date;
}

/**
 * Raison socket.io quand l'appli ferme elle-même son socket (appli glissée
 * hors des récentes sur un Android d'origine, écran détruit, compte
 * déconnecté). Une coupure du réseau ou une appli gelée donne `ping timeout`,
 * un processus tué `transport close`.
 */
export const RAISON_FERMEE_PAR_L_APPLI = 'client namespace disconnect';

/** Une position partie juste avant la fermeture arrive au plus 20 s après (délai d'envoi de l'appli). */
export const MARGE_FIN_SOCKET_MS = 30_000;

/** État de l'appli d'un livreur : active, fermée par lui (prouvé), ou connexion coupée. */
export type EtatAppli = 'ACTIVE' | 'FERMEE' | 'COUPURE';

/**
 * L'appli a fermé elle-même son socket, et rien n'est venu d'elle ensuite
 * (plus de `MARGE_FIN_SOCKET_MS` après). Toute autre fin, ou aucune fin
 * connue : non. En cas de doute, la réponse est non (« Connexion coupée »).
 */
export function fermetureProuvee(fin: FinSocket | undefined, dernierSignal: Date | null): boolean {
  if (!fin || fin.raison !== RAISON_FERMEE_PAR_L_APPLI) return false;
  return dernierSignal === null || dernierSignal.getTime() <= fin.a.getTime() + MARGE_FIN_SOCKET_MS;
}

// ============================================================
// EN APPEL AVEC LE SERVICE CLIENT
// ============================================================

/**
 * Appels vivants d'un livreur, appelant ou appelé : qui sonne depuis moins de
 * 60 s (45 s de sonnerie et une marge), ou en ligne depuis moins de 4 h. Même
 * fenêtre que `GET /calls/deliverer/active` : un appel resté « RINGING » ou
 * « ONGOING » après un redémarrage n'écarte personne au-delà.
 */
export function filtreAppelsVivantsLivreurs(maintenant: Date): Prisma.CallWhereInput {
  const t = maintenant.getTime();
  return {
    AND: [
      { OR: [{ caller_deliverer_id: { not: null } }, { target_deliverer_id: { not: null } }] },
      {
        OR: [
          {
            status: CallStatus.RINGING,
            started_at: { gte: new Date(t - SONNERIE_LIVREUR_MS - MARGE_SONNERIE_LIVREUR_MS) },
          },
          { status: CallStatus.ONGOING, started_at: { gte: new Date(t - APPEL_FANTOME_MS) } },
        ],
      },
    ],
  };
}

/** Livreurs de ces appels vivants, appelants ou appelés. */
export function livreursDesAppels(
  appels: readonly { caller_deliverer_id: string | null; target_deliverer_id: string | null }[],
): Set<string> {
  const ids = new Set<string>();
  for (const a of appels) {
    if (a.caller_deliverer_id) ids.add(a.caller_deliverer_id);
    if (a.target_deliverer_id) ids.add(a.target_deliverer_id);
  }
  return ids;
}

// ============================================================
// JOIGNABLE OU NON
// ============================================================

/** Réglage de la règle des livreurs joignables (1 par défaut, 0 = coupée). */
export const CLE_OFFRE_JOIGNABLES_SEULEMENT = 'course.offre_joignables_seulement';

/**
 * Lecture du réglage, comme les autres réglages de course à deux valeurs
 * (`CourseSettingsHelper`) : absent ou vide, défaut 1 (règle active) ;
 * « 1 », « true », « on », « yes » : active ; toute autre valeur la coupe.
 */
export function lireOffreJoignablesSeulement(brut: string | undefined): boolean {
  if (brut === undefined || brut === '') return true;
  const v = brut.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

/** Un jeton de notification utilisable : une chaîne non vide (le serveur l'efface à la déconnexion). */
export function aUnJetonDeNotification(jeton: string | null | undefined): boolean {
  return typeof jeton === 'string' && jeton.trim() !== '';
}

/**
 * Livreurs dont le jeton a été LU (`expo_push_token` présent dans la ligne,
 * même à null) et qui n'en ont pas : leur présence (socket) décide.
 */
export function idsSansJeton(lignes: readonly { id: string; expo_push_token?: string | null }[]): string[] {
  return lignes
    .filter((l) => l.expo_push_token !== undefined && !aUnJetonDeNotification(l.expo_push_token))
    .map((l) => l.id);
}

/**
 * Livreurs injoignables parmi ces lignes : sans jeton (`idsSansJeton`) et
 * sans socket ouvert. Présence inconnue (`connectes` null) : null, personne
 * n'est réputé injoignable.
 */
export function injoignablesParmi(
  lignes: readonly { id: string; expo_push_token?: string | null }[],
  connectes: ReadonlySet<string> | null,
): Set<string> | null {
  if (!connectes) return null;
  return new Set(idsSansJeton(lignes).filter((id) => !connectes.has(id)));
}

/**
 * Règle de l'appli coupée : réglage à 0, ou livreur qui répond à l'instant
 * (acceptation d'une offre : son appli est forcément ouverte).
 */
export const SANS_REGLE_APPLI: ContexteAppli = { appliFermeeApresS: 0, connectes: null };

/**
 * L'appli du livreur est-elle active ? Oui avec un socket ouvert, ou avec un
 * signe de vie de MOINS de `appliFermeeApresS` secondes (borne exclue). Règle
 * coupée (0) : toujours oui.
 */
export function estAppliActive(
  p: { socket_connecte: boolean | null; dernier_signal_at: Date | null },
  maintenant: Date,
  appliFermeeApresS: number,
): boolean {
  if (!(appliFermeeApresS > 0)) return true;
  if (p.socket_connecte === true) return true;
  return (
    p.dernier_signal_at !== null &&
    maintenant.getTime() - p.dernier_signal_at.getTime() < appliFermeeApresS * 1000
  );
}

/**
 * Appli active d'une ligne lue en base (`id`, `dernier_signal_at`,
 * `protocole_appli`) dans ce contexte. Appli d'avant le protocole 4 :
 * toujours active (la règle ne la vise pas).
 */
export function appliActiveDepuis(
  ligne: { id: string; dernier_signal_at: Date | null; protocole_appli: number | null },
  appli: ContexteAppli,
  maintenant: Date,
): boolean {
  if (!regleAppliPour(ligne.protocole_appli, appli.appliFermeeApresS)) return true;
  return estAppliActive(
    {
      socket_connecte: appli.connectes ? appli.connectes.has(ligne.id) : null,
      dernier_signal_at: ligne.dernier_signal_at,
    },
    maintenant,
    appli.appliFermeeApresS,
  );
}

/**
 * État de l'appli d'une ligne lue en base dans ce contexte : ACTIVE (socket
 * ouvert ou signe de vie récent), FERMEE (fermeture prouvée), sinon COUPURE.
 * Null : la règle ne vise pas ce livreur (réglage à 0, appli d'avant le
 * protocole 4).
 */
export function etatAppliDepuis(
  ligne: { id: string; dernier_signal_at: Date | null; protocole_appli: number | null },
  appli: ContexteAppli,
  maintenant: Date,
): EtatAppli | null {
  if (!regleAppliPour(ligne.protocole_appli, appli.appliFermeeApresS)) return null;
  if (appliActiveDepuis(ligne, appli, maintenant)) return 'ACTIVE';
  return fermetureProuvee(appli.finsSocket?.get(ligne.id), ligne.dernier_signal_at) ? 'FERMEE' : 'COUPURE';
}

export function peutRecevoirOffre(l: EtatLivreur, maintenant: Date): DecisionOffre {
  if (
    l.status !== DelivererStatus.ACTIVE ||
    !l.is_operational ||
    l.entity_status !== EntityStatus.ACTIVE
  ) {
    return { ok: false, motif: 'INACTIF' };
  }
  if (estEnPause(l, maintenant)) return { ok: false, motif: 'EN_PAUSE' };
  if (estEnPauseAuto(l, maintenant)) return { ok: false, motif: 'PAUSE_AUTO' };
  if (l.en_course) return { ok: false, motif: 'EN_COURSE' };
  if (l.offre_en_attente) return { ok: false, motif: 'OFFRE_EN_ATTENTE' };
  if (!estEnService(l)) return { ok: false, motif: 'HORS_SERVICE' };
  if (!l.appli_active) return { ok: false, motif: l.appli_fermee_prouvee ? 'APPLI_FERMEE' : 'CONNEXION_COUPEE' };
  if (l.joignable === false) return { ok: false, motif: 'INJOIGNABLE' };
  if (l.en_appel === true) return { ok: false, motif: 'EN_APPEL' };
  return { ok: true };
}

/**
 * La même règle, en filtre Prisma, pour la sélection des candidats. Toute
 * modification de `peutRecevoirOffre` doit s'y refléter : le test
 * d'équivalence (disponibilite.rules.spec.ts) casse sinon.
 *
 * Bornes : la pause est active quand sa fin est STRICTEMENT future, donc le
 * livreur redevient candidat dès `pause_until <= maintenant` (`lte`) ; l'appli
 * est active avec un signe de vie de MOINS de N secondes, donc postérieur à
 * `maintenant - N` (`gt`).
 *
 * @param appli  Réglage et sockets ouverts (`AppliLivreurService`) : les
 *   livreurs au signe de vie trop vieux ne passent que par leur socket.
 */
export function filtreLivreursPouvantRecevoirOffre(
  maintenant: Date,
  appli: ContexteAppli,
): Prisma.DelivererWhereInput {
  const conditions: Prisma.DelivererWhereInput[] = [
    { OR: [{ pause_until: null }, { pause_until: { lte: maintenant } }] },
    { OR: [{ auto_pause_until: null }, { auto_pause_until: { lte: maintenant } }] },
    { courses: { none: { statut: { in: STATUTS_COURSE_EN_COURS } } } },
    { offer_attempts: { none: { status: CourseOfferStatus.PENDING } } },
  ];
  if (appli.appliFermeeApresS > 0) {
    const connectes = [...(appli.connectes ?? [])];
    conditions.push({
      OR: [
        // Appli d'avant le protocole 4 : la règle ne la vise pas.
        { protocole_appli: null },
        { protocole_appli: { lt: PROTOCOLE_APPLI_FERMEE } },
        { dernier_signal_at: { gt: new Date(maintenant.getTime() - appli.appliFermeeApresS * 1000) } },
        ...(connectes.length > 0 ? [{ id: { in: connectes } }] : []),
      ],
    });
  }
  // Injoignables (ni socket ni jeton), jugés au contexte : passés.
  if (appli.injoignables && appli.injoignables.size > 0) {
    conditions.push({ id: { notIn: [...appli.injoignables] } });
  }
  // En appel avec le service client, jugés au contexte : passés.
  if (appli.enAppel && appli.enAppel.size > 0) {
    conditions.push({ id: { notIn: [...appli.enAppel] } });
  }
  return {
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    last_available_at: { not: null },
    AND: conditions,
  };
}

/**
 * Lecture de l'état d'UN livreur (affectation forcée, acceptation, relances) :
 * `prisma.deliverer.findUnique({ where: { id }, select: SELECT_ETAT_LIVREUR })`
 * puis `etatLivreurDepuis(ligne, appli, maintenant)`.
 */
export const SELECT_ETAT_LIVREUR = {
  id: true,
  restaurant_id: true,
  status: true,
  is_operational: true,
  entity_status: true,
  pause_until: true,
  auto_pause_until: true,
  last_available_at: true,
  dernier_signal_at: true,
  protocole_appli: true,
  _count: {
    select: {
      courses: { where: { statut: { in: STATUTS_COURSE_EN_COURS } } },
      offer_attempts: { where: { status: CourseOfferStatus.PENDING } },
    },
  },
} satisfies Prisma.DelivererSelect;

export type LigneEtatLivreur = Prisma.DelivererGetPayload<{ select: typeof SELECT_ETAT_LIVREUR }>;

export function etatLivreurDepuis(
  ligne: LigneEtatLivreur,
  appli: ContexteAppli,
  maintenant: Date,
): EtatLivreur {
  return {
    status: ligne.status,
    is_operational: ligne.is_operational,
    entity_status: ligne.entity_status,
    pause_until: ligne.pause_until,
    auto_pause_until: ligne.auto_pause_until,
    last_available_at: ligne.last_available_at,
    en_course: ligne._count.courses > 0,
    offre_en_attente: ligne._count.offer_attempts > 0,
    appli_active: appliActiveDepuis(ligne, appli, maintenant),
    appli_fermee_prouvee: fermetureProuvee(appli.finsSocket?.get(ligne.id), ligne.dernier_signal_at),
    appli_vue_a: ligne.dernier_signal_at,
    // Jugée seulement quand le contexte l'a été (règle active, jetons lus, présence connue).
    ...(appli.injoignables ? { joignable: !appli.injoignables.has(ligne.id) } : {}),
    ...(appli.enAppel ? { en_appel: appli.enAppel.has(ligne.id) } : {}),
  };
}

// ============================================================
// TEXTES (français simple, heure d'Abidjan = UTC)
// ============================================================

/** « 14 h 32 », ou « le 23/10 à 14 h 32 » si ce n'est pas le même jour. */
export function heureLisible(date: Date, maintenant: Date): string {
  const heure = `${date.getUTCHours()} h ${String(date.getUTCMinutes()).padStart(2, '0')}`;
  const memeJour =
    date.getUTCFullYear() === maintenant.getUTCFullYear() &&
    date.getUTCMonth() === maintenant.getUTCMonth() &&
    date.getUTCDate() === maintenant.getUTCDate();
  if (memeJour) return heure;
  const jour = String(date.getUTCDate()).padStart(2, '0');
  const mois = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `le ${jour}/${mois} à ${heure}`;
}

const estIndefinie = (date: Date) => date.getTime() >= FIN_PAUSE_INDEFINIE.getTime() - 24 * 3600_000;

/** « jusqu'à 14 h 32 », « jusqu'au 23/10 à 14 h 32 », ou rien pour une pause sans fin. */
function jusqua(date: Date | null, maintenant: Date): string {
  if (!date || estIndefinie(date)) return '';
  const h = heureLisible(date, maintenant);
  return h.startsWith('le ') ? ` jusqu'au ${h.slice(3)}` : ` jusqu'à ${h}`;
}

/** Réponse à « Reprendre » pendant une pause automatique. */
export function messagePauseAuto(autoPauseUntil: Date, maintenant: Date): string {
  return `Pause automatique${jusqua(autoPauseUntil, maintenant)}.`;
}

// ============================================================
// AFFICHAGE AU BACKOFFICE (liste des livreurs, carte, affectation forcée)
// ============================================================

/** État d'un livreur pour l'affichage : disponible, ou la raison du refus. */
export type EtatAffichageLivreur = 'DISPONIBLE' | MotifRefusOffre;

/** Ce que le serveur renvoie à côté de chaque livreur (champ `disponibilite`). */
export interface DisponibiliteLivreur {
  etat: EtatAffichageLivreur;
  /** Texte à afficher tel quel : « En pause jusqu'à 14 h 32 », « Hors service »… */
  libelle: string;
  /** Peut recevoir une offre (et donc une affectation forcée) maintenant. */
  peut_recevoir_offre: boolean;
  /** Raison du refus d'une affectation forcée, telle que le serveur la renverrait (409). */
  message_refus: string | null;
  en_pause: boolean;
  en_pause_auto: boolean;
  pause_until: Date | null;
  auto_pause_until: Date | null;
  /** Dans la file (`last_available_at` non nul). */
  en_service: boolean;
  en_course: boolean;
  offre_en_attente: boolean;
  /** Course de l'offre en attente : l'affectation forcée sur CETTE course reste permise (renvoi). */
  offre_course_id: string | null;
  /**
   * Appli active : socket ouvert ou signe de vie récent. Faux : « Appli
   * fermée » ou « Connexion coupée » (`appli_etat`), plus aucune offre jusqu'à
   * son retour. Null : règle coupée (`deliverer.appli_fermee_apres_s` à 0),
   * état de l'appli inconnu.
   */
  appli_active: boolean | null;
  /** Dernier signe de vie de l'appli (position ou requête), null si jamais vu. */
  appli_vue_a: Date | null;
  /**
   * État de l'appli, lu aussi quand l'état affiché est autre (en course) :
   * ACTIVE, FERMEE (fermée par le livreur, prouvé : « Appli fermée ») ou
   * COUPURE (silence sans preuve : « Connexion coupée »). Null : règle coupée
   * ou appli d'avant le protocole 4.
   */
  appli_etat: EtatAppli | null;
}

const LIBELLES: Record<EtatAffichageLivreur, string> = {
  DISPONIBLE: 'Disponible',
  INACTIF: 'Inactif',
  EN_PAUSE: 'En pause',
  PAUSE_AUTO: 'Pause automatique',
  EN_COURSE: 'En course',
  OFFRE_EN_ATTENTE: 'Offre en attente',
  HORS_SERVICE: 'Hors service',
  APPLI_FERMEE: 'Appli fermée',
  CONNEXION_COUPEE: 'Connexion coupée',
  INJOIGNABLE: 'Injoignable',
  EN_APPEL: 'En appel',
};

/**
 * État d'un livreur à afficher au backoffice, calculé par la règle unique :
 * l'écran montre exactement ce que le serveur refuserait.
 *
 * @param regleAppli  Règle de l'appli fermée active (réglage au-dessus de 0).
 *   Coupée, la règle tient toute appli pour active ; l'écran, lui, ne sait
 *   pas : `appli_active` vaut null (« Appli non connectée » sans socket).
 */
export function disponibiliteLivreur(
  l: EtatLivreur,
  maintenant: Date,
  offreCourseId: string | null = null,
  regleAppli = true,
): DisponibiliteLivreur {
  const decision = peutRecevoirOffre(l, maintenant);
  const etat: EtatAffichageLivreur = decision.ok ? 'DISPONIBLE' : decision.motif;
  let libelle = LIBELLES[etat];
  if (etat === 'EN_PAUSE') libelle += jusqua(l.pause_until, maintenant);
  if (etat === 'PAUSE_AUTO') libelle += jusqua(l.auto_pause_until, maintenant);
  return {
    etat,
    libelle,
    peut_recevoir_offre: decision.ok,
    message_refus: decision.ok ? null : messageRefusOffre(decision.motif, l, maintenant),
    en_pause: estEnPause(l, maintenant),
    en_pause_auto: estEnPauseAuto(l, maintenant),
    pause_until: l.pause_until,
    auto_pause_until: l.auto_pause_until,
    en_service: estEnService(l),
    en_course: l.en_course,
    offre_en_attente: l.offre_en_attente,
    offre_course_id: l.offre_en_attente ? offreCourseId : null,
    appli_active: regleAppli ? l.appli_active : null,
    appli_vue_a: l.appli_vue_a ?? null,
    appli_etat: regleAppli ? etatAppliDe(l) : null,
  };
}

/** État de l'appli d'un livreur déjà jugé : active, fermée (prouvé), sinon connexion coupée. */
function etatAppliDe(l: Pick<EtatLivreur, 'appli_active' | 'appli_fermee_prouvee'>): EtatAppli {
  if (l.appli_active) return 'ACTIVE';
  return l.appli_fermee_prouvee ? 'FERMEE' : 'COUPURE';
}

/**
 * Raison, en français, pour laquelle un livreur ne peut pas recevoir d'offre
 * (refus de l'affectation forcée, affichage au backoffice).
 */
export function messageRefusOffre(
  motif: MotifRefusOffre,
  l: Pick<EtatLivreur, 'pause_until' | 'auto_pause_until'>,
  maintenant: Date,
): string {
  switch (motif) {
    case 'INACTIF':
      return "Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant.";
    case 'EN_PAUSE':
      return `Ce livreur est en pause${jusqua(l.pause_until, maintenant)}.`;
    case 'PAUSE_AUTO':
      return `Ce livreur est en pause automatique${jusqua(l.auto_pause_until, maintenant)}.`;
    case 'EN_COURSE':
      return 'Ce livreur a déjà une course en cours.';
    case 'OFFRE_EN_ATTENTE':
      return 'Ce livreur a déjà une offre en attente de réponse.';
    case 'HORS_SERVICE':
      return "Ce livreur est hors service : il n'a pas repris le travail dans l'appli.";
    case 'APPLI_FERMEE':
      return "L'appli de ce livreur est fermée.";
    case 'CONNEXION_COUPEE':
      return 'La connexion de ce livreur est coupée : son appli ne répond plus.';
    case 'INJOIGNABLE':
      return 'Ce livreur est injoignable : ni appli connectée, ni notifications.';
    case 'EN_APPEL':
      return 'Ce livreur est en appel avec le call center.';
  }
}
