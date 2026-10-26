/**
 * « APPLI FERMÉE » À TORT (retour du client après le test réel du 25/10) :
 * « L'appli livreur n'est pas fermée [...] mais au niveau du backoffice, c'est
 * affiché l'appli fermée. Je ne sais pas si c'est parce que l'écran de
 * l'appareil s'est verrouillé ou si c'est la connexion qui est interrompue. »
 *
 * Règle du client (24/10) : appli en arrière-plan ou écran verrouillé =
 * ACTIVE ; appli fermée par le livreur = FERMÉE ; connexion coupée = ni l'un
 * ni l'autre, à montrer comme telle (« Connexion coupée »).
 *
 * Scénarios de la conception (`.banc-test-crm/appli-fermee-correction.md`,
 * § 6), joués seconde par seconde sur les VRAIES règles : la ligne du livreur
 * (signe de vie), la présence (socket ouvert) et la fin du dernier socket
 * gardée par le serveur (raison socket.io : `client namespace disconnect`
 * quand l'appli ferme elle-même son socket, `ping timeout` pour un réseau
 * coupé ou une appli gelée, `transport close` pour un processus tué).
 *
 * T = début de l'événement, 17 h 31 (Abidjan = UTC). Réglage à 180 s, appli
 * protocole 4. En service, une position toutes les 60 s ; en course, toutes
 * les 14 s. Dernière position à T - 50 s sauf mention.
 */
import { CourseStatut, DelivererStatus, EntityStatus } from '@prisma/client';

import { construireTableau, LivreurLu } from 'src/modules/course/helpers/tableau-livraison.rules';
import { decisionExpiration, decisionRelance } from 'src/modules/course/helpers/offres.rules';
import { appliOperations } from 'src/modules/order/helpers/suivi-operations.rules';

import {
  ContexteAppli,
  EtatAppli,
  FinSocket,
  disponibiliteLivreur,
  etatAppliDepuis,
  etatLivreurDepuis,
  regleAppliPour,
} from './disponibilite.rules';

const ID = 'liv-koffi';
const SEUIL = 180;
const T = new Date('2026-10-25T17:31:00.000Z');
const s = (n: number) => new Date(T.getTime() + n * 1000);

const FERMEE_PAR_L_APPLI = 'client namespace disconnect';

interface Scenario {
  /** Positions reçues par le serveur (secondes depuis T) : chacune écrit le signe de vie. */
  positions: number[];
  /** Requêtes authentifiées qui écrivent aussi le signe de vie. */
  requetes?: number[];
  /** Sockets de l'appli : ouverture, fin, et raison socket.io de la fin. */
  sockets: { de: number; a?: number; raison?: string }[];
  /** Livreur en course (positions plus serrées, alertes du tableau). */
  enCourse?: boolean;
  /** Redis des fins de socket muet : aucune preuve lisible. */
  finsMuettes?: boolean;
  /** Présence illisible (Redis de socket.io ou l'autre serveur muet). */
  presenceMuette?: boolean;
  /** Ni socket ni jeton : injoignable (règle des joignables). */
  injoignable?: boolean;
}

/** Positions de `de` à `jusqua` (inclus), toutes les `pas` secondes. */
function toutesLes(pas: number, de: number, jusqua: number): number[] {
  const res: number[] = [];
  for (let t = de; t <= jusqua; t += pas) res.push(t);
  return res;
}

/** Ce que le serveur sait à l'instant `t` (secondes depuis T). */
function contexteA(sc: Scenario, t: number): { appli: ContexteAppli; dernier: Date | null; position: Date | null } {
  const signaux = [...sc.positions, ...(sc.requetes ?? [])].filter((x) => x <= t);
  const positions = sc.positions.filter((x) => x <= t);
  const ouvert = sc.sockets.some((k) => k.de <= t && (k.a === undefined || t < k.a));
  // Fin gardée au serveur : écrite à chaque fin de socket, effacée à chaque ouverture.
  const evenements = sc.sockets
    .flatMap((k) => [
      { t: k.de, fin: null as FinSocket | null },
      ...(k.a !== undefined ? [{ t: k.a, fin: { raison: k.raison ?? 'transport close', a: s(k.a) } }] : []),
    ])
    .filter((e) => e.t <= t)
    .sort((x, y) => x.t - y.t || (x.fin ? -1 : 1));
  let fin: FinSocket | null = null;
  for (const e of evenements) fin = e.fin;
  const appli: ContexteAppli = {
    appliFermeeApresS: SEUIL,
    connectes: sc.presenceMuette ? null : new Set(ouvert ? [ID] : []),
    finsSocket: sc.finsMuettes ? null : new Map(fin ? [[ID, fin]] : []),
  };
  if (sc.injoignable) appli.injoignables = new Set(ouvert ? [] : [ID]);
  return {
    appli,
    dernier: signaux.length > 0 ? s(Math.max(...signaux)) : null,
    position: positions.length > 0 ? s(Math.max(...positions)) : null,
  };
}

/** Tout ce que le backoffice reçoit à l'instant `t` : liste et carte, écran Commandes, tableau Livraison. */
function vu(sc: Scenario, t: number) {
  const { appli, dernier, position } = contexteA(sc, t);
  const maintenant = s(t);
  const ligne = {
    id: ID,
    restaurant_id: 'r-angre',
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    pause_until: null,
    auto_pause_until: null,
    last_available_at: sc.enCourse ? null : s(-3600),
    dernier_signal_at: dernier,
    protocole_appli: 4,
    _count: { courses: sc.enCourse ? 1 : 0, offer_attempts: 0 },
  };
  const etatLivreur = etatLivreurDepuis(ligne, appli, maintenant);
  const dispo = disponibiliteLivreur(etatLivreur, maintenant, null, regleAppliPour(4, SEUIL));
  const operations = appliOperations({ id: ID, dernier_signal_at: dernier, protocole_appli: 4 }, maintenant, appli);
  const lu: LivreurLu = {
    id: ID,
    first_name: 'Koffi',
    restaurant: { id: 'r-angre' },
    disponibilite: { etat: dispo.etat },
    rang_file: null,
    appli_active: dispo.appli_active,
    appli_vue_a: dispo.appli_vue_a?.toISOString() ?? null,
    appli_etat: dispo.appli_etat,
    location_at: position?.toISOString() ?? null,
    active_course: sc.enCourse ? { id: 'c-1', reference: 'CRS-251025-0007', statut: CourseStatut.IN_DELIVERY } : null,
  };
  const tableau = construireTableau({
    maintenant,
    reglages: { facteurRetard: 1.5, sansLivreurAlerteMin: 5, attenteAuRestaurantMin: 15, positionExpireeMin: 5 },
    restaurants: [{ id: 'r-angre', nom: 'Angré' }],
    livreurs: [lu],
    courses: [],
    aEncaisser: [],
    livrees: [],
    planning: { jour: new Date('2026-10-25T00:00:00.000Z'), plans: [], repos: [], absents: [] },
  });
  return {
    etat: etatAppliDepuis({ id: ID, dernier_signal_at: dernier, protocole_appli: 4 }, appli, maintenant),
    etatLivreur,
    dispo,
    operations,
    alertes: tableau.signaux.map((x) => x.cle),
  };
}

/** État de l'appli à chaque seconde de `de` à `jusqua`, regroupé en plages : [[de, état], …]. */
function plages(sc: Scenario, de: number, jusqua: number): [number, EtatAppli | null][] {
  const res: [number, EtatAppli | null][] = [];
  for (let t = de; t <= jusqua; t++) {
    const e = vu(sc, t).etat;
    if (res.length === 0 || res[res.length - 1][1] !== e) res.push([t, e]);
  }
  return res;
}

/** En service : une position toutes les 60 s jusqu'à T - 50 s. */
const AVANT_T = toutesLes(60, -590, -50);
/** En course : une position toutes les 14 s jusqu'à T - 14 s. */
const AVANT_T_EN_COURSE = toutesLes(14, -602, -14);
/** Socket ouvert depuis le début du service. */
const DEPUIS_LE_SERVICE = -3600;

describe('Écran verrouillé, autre appli : l’appli reste ACTIVE tant que les positions passent', () => {
  it.each<[string, Scenario['sockets']]>([
    ['écran verrouillé 10 min, Android d’origine, socket tombé et pas relancé (pire cas)', [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }]],
    ['écran verrouillé 10 min, socket gardé', [{ de: DEPUIS_LE_SERVICE }]],
    ['autre appli 10 min (WhatsApp), socket fermé net par le système puis relancé', [
      { de: DEPUIS_LE_SERVICE, a: 30, raison: 'transport close' },
      { de: 70 },
    ]],
  ])('%s : ACTIVE à chaque seconde, rien à signaler', (_nom, sockets) => {
    const sc: Scenario = { positions: toutesLes(60, -590, 600), sockets };
    expect(plages(sc, 0, 600)).toEqual([[0, 'ACTIVE']]);
    const v = vu(sc, 600);
    expect(v.dispo).toMatchObject({ etat: 'DISPONIBLE', peut_recevoir_offre: true, appli_active: true, appli_etat: 'ACTIVE' });
    expect(v.operations.appli_etat).toBe('ACTIVE');
  });
});

describe('Téléphone qui gèle ou tue l’appli (surcouche Tecno, Infinix, Xiaomi, Samsung) : « Connexion coupée »', () => {
  it('écran verrouillé, appli gelée : plus de position, fin `ping timeout` à T + 45 s ; COUPURE dès T + 130 s, jamais FERMEE', () => {
    const sc: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }] };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'COUPURE'],
    ]);
    const v = vu(sc, 4 * 60);
    expect(v.dispo).toMatchObject({
      etat: 'CONNEXION_COUPEE',
      libelle: 'Connexion coupée',
      peut_recevoir_offre: false,
      message_refus: 'La connexion de ce livreur est coupée : son appli ne répond plus.',
      appli_active: false,
      appli_etat: 'COUPURE',
      appli_vue_a: s(-50),
    });
    expect(v.operations).toEqual({
      appli_active: false,
      appli_vue_a: s(-50).toISOString(),
      appli_connectee: false,
      appli_etat: 'COUPURE',
    });
  });

  it('écran verrouillé, appli tuée : fin `transport close` tout de suite ; COUPURE dès T + 130 s', () => {
    const sc: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: 'transport close' }] };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'COUPURE'],
    ]);
  });
});

describe('Réseau coupé : « Connexion coupée », jamais « Appli fermée »', () => {
  it('2 min en service : au pire « Connexion coupée » quelques secondes, puis ACTIVE au retour', () => {
    // Coupure de T à T + 120 s : les envois de T + 10, 40, 70 et 100 s sont perdus ; celui
    // de T + 130 s arrive avec 5 s de retard, le socket repart avec lui.
    const sc: Scenario = {
      positions: [...AVANT_T, ...toutesLes(60, 135, 600)],
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }, { de: 135 }],
    };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'COUPURE'],
      [135, 'ACTIVE'],
    ]);
    for (let t = 0; t <= 600; t++) expect(vu(sc, t).dispo.etat).not.toBe('APPLI_FERMEE');
  });

  it('2 min en course : positions toutes les 14 s, silence de 140 s au plus ; ACTIVE, aucune alerte', () => {
    const sc: Scenario = {
      enCourse: true,
      positions: [...AVANT_T_EN_COURSE, ...toutesLes(14, 126, 600)],
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }, { de: 126 }],
    };
    expect(plages(sc, 0, 600)).toEqual([[0, 'ACTIVE']]);
    for (const t of [60, 125, 200]) expect(vu(sc, t).alertes).toEqual([]);
  });

  it('10 min en service : COUPURE de T + 130 s au retour, « Connexion coupée », offre impossible', () => {
    const sc: Scenario = {
      positions: [...AVANT_T, ...toutesLes(60, 605, 900)],
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }, { de: 605 }],
    };
    expect(plages(sc, 0, 900)).toEqual([
      [0, 'ACTIVE'],
      [130, 'COUPURE'],
      [605, 'ACTIVE'],
    ]);
    expect(vu(sc, 400).dispo).toMatchObject({ etat: 'CONNEXION_COUPEE', libelle: 'Connexion coupée', peut_recevoir_offre: false });
  });

  it('10 min en course : alerte « plus de position » après 5 min, plus « appli fermée pendant une course »', () => {
    const sc: Scenario = {
      enCourse: true,
      positions: AVANT_T_EN_COURSE,
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }],
    };
    // Position de 4 min : appli coupée, pas encore d'alerte.
    expect(vu(sc, 4 * 60 - 14)).toMatchObject({ etat: 'COUPURE', alertes: [] });
    // Position de 6 min : « Koffi : plus de position depuis 6 min ».
    expect(vu(sc, 6 * 60 - 14)).toMatchObject({ etat: 'COUPURE', alertes: ['POSITION_PERDUE_EN_COURSE'] });
    // En course, l'état reste celui de la course, l'appli se lit à côté.
    expect(vu(sc, 6 * 60 - 14).dispo).toMatchObject({ etat: 'EN_COURSE', appli_active: false, appli_etat: 'COUPURE' });
  });
});

describe('Appli glissée hors des applis récentes : « Appli fermée » seulement sur preuve', () => {
  it('Android d’origine : fin `client namespace disconnect` à T, rien ensuite ; ACTIVE (en arrière-plan) puis FERMEE à T + 130 s', () => {
    const sc: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }] };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'FERMEE'],
    ]);
    // Juste après le geste : en arrière-plan (sans socket, signe de vie récent).
    expect(vu(sc, 60).operations).toMatchObject({ appli_active: true, appli_connectee: false, appli_etat: 'ACTIVE' });
    const v = vu(sc, 3 * 60);
    expect(v.dispo).toMatchObject({
      etat: 'APPLI_FERMEE',
      libelle: 'Appli fermée',
      peut_recevoir_offre: false,
      message_refus: "L'appli de ce livreur est fermée.",
      appli_active: false,
      appli_etat: 'FERMEE',
    });
    expect(v.operations.appli_etat).toBe('FERMEE');
  });

  it('une position partie juste avant le geste, reçue 20 s après la fermeture : toujours FERMEE', () => {
    const sc: Scenario = { positions: [...AVANT_T, 20], sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }] };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [200, 'FERMEE'],
    ]);
  });

  it('en course : « appli fermée pendant une course » (vraie fermeture), sans « plus de position »', () => {
    const sc: Scenario = {
      enCourse: true,
      positions: AVANT_T_EN_COURSE,
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }],
    };
    expect(vu(sc, 6 * 60)).toMatchObject({ etat: 'FERMEE', alertes: ['APPLI_FERMEE_EN_COURSE'] });
  });

  it('arrêt forcé par la surcouche (`transport close`) : COUPURE (limite connue, mêmes effets)', () => {
    const sc: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: 'transport close' }] };
    expect(vu(sc, 4 * 60).etat).toBe('COUPURE');
  });

  it('socket déjà tombé (`ping timeout`) avant le geste : COUPURE (sens sûr)', () => {
    const sc: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: -100, raison: 'ping timeout' }] };
    expect(vu(sc, 4 * 60).etat).toBe('COUPURE');
  });
});

describe('Autres cas de la conception', () => {
  it('Android détruit l’écran puis le recrée : FERMEE pendant l’absence (limite), ACTIVE dès la réouverture', () => {
    const sc: Scenario = {
      positions: [...AVANT_T, ...toutesLes(60, 400, 600)],
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }, { de: 400 }],
    };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'FERMEE'],
      [400, 'ACTIVE'],
    ]);
  });

  it('téléphone redémarré : COUPURE jusqu’à la réouverture', () => {
    const sc: Scenario = {
      positions: [...AVANT_T, ...toutesLes(60, 300, 600)],
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: 'transport close' }, { de: 300 }],
    };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'COUPURE'],
      [300, 'ACTIVE'],
    ]);
  });

  it('appli rouverte après une fermeture, socket en échec, requêtes HTTP qui passent, puis silence : COUPURE (fin périmée)', () => {
    const sc: Scenario = {
      positions: AVANT_T,
      requetes: [60, 90, 120],
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }],
    };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [300, 'COUPURE'],
    ]);
  });

  it('serveur redéployé (`server shutting down`), reconnexion en 3 s : ACTIVE', () => {
    const sc: Scenario = {
      positions: toutesLes(60, -590, 600),
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: 'server shutting down' }, { de: 3 }],
    };
    expect(plages(sc, 0, 600)).toEqual([[0, 'ACTIVE']]);
  });

  it('fins de socket illisibles (Redis muet) : jamais FERMEE, COUPURE après 180 s de silence', () => {
    const sc: Scenario = {
      positions: AVANT_T,
      sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }],
      finsMuettes: true,
    };
    expect(plages(sc, 0, 600)).toEqual([
      [0, 'ACTIVE'],
      [130, 'COUPURE'],
    ]);
  });

  it('présence illisible et signe de vie vieux : COUPURE, jamais « Appli fermée » sans preuve', () => {
    const sc: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE }], presenceMuette: true };
    expect(vu(sc, 4 * 60)).toMatchObject({ etat: 'COUPURE', dispo: { etat: 'CONNEXION_COUPEE' } });
  });

  it('livreur injoignable (signe de vie récent, ni socket ni jeton) : « Injoignable », appli ACTIVE, jamais « Appli fermée »', () => {
    const sc: Scenario = {
      positions: toutesLes(60, -590, 600),
      sockets: [{ de: DEPUIS_LE_SERVICE, a: -300, raison: 'ping timeout' }],
      injoignable: true,
    };
    const v = vu(sc, 60);
    expect(v.dispo).toMatchObject({ etat: 'INJOIGNABLE', libelle: 'Injoignable', appli_active: true, appli_etat: 'ACTIVE' });
  });
});

describe('Appli glissée et réseau coupé : deux affichages différents, les mêmes effets', () => {
  const glissee: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: 0, raison: FERMEE_PAR_L_APPLI }] };
  const coupure: Scenario = { positions: AVANT_T, sockets: [{ de: DEPUIS_LE_SERVICE, a: 45, raison: 'ping timeout' }] };
  const EN_RECHERCHE = { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: null };

  it('4 min après : même dernier signe de vie, même absence de socket, mais « Appli fermée » et « Connexion coupée »', () => {
    const a = vu(glissee, 4 * 60);
    const b = vu(coupure, 4 * 60);
    expect([a.dispo.libelle, b.dispo.libelle]).toEqual(['Appli fermée', 'Connexion coupée']);
    expect([a.operations.appli_etat, b.operations.appli_etat]).toEqual(['FERMEE', 'COUPURE']);
    expect(a.operations.appli_vue_a).toBe(b.operations.appli_vue_a);
  });

  it('aucune offre, offre en attente close sans pénalité (motif APPLI_FERMEE), dans les deux cas', () => {
    for (const sc of [glissee, coupure]) {
      const v = vu(sc, 4 * 60);
      expect(v.dispo.peut_recevoir_offre).toBe(false);
      expect(decisionRelance(EN_RECHERCHE, v.etatLivreur, s(4 * 60))).toMatchObject({ relancer: false, motif: 'APPLI_FERMEE' });
      expect(decisionExpiration(EN_RECHERCHE, v.etatLivreur, s(4 * 60))).toEqual({ penaliser: false, raison: 'APPLI_FERMEE' });
    }
  });
});
