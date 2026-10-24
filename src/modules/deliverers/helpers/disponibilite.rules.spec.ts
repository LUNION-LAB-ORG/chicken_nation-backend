/**
 * Règle unique : un livreur peut-il recevoir une offre ? (demande du 22/10,
 * « un livreur en pause ne doit pas recevoir de commandes » ; demande du
 * 24/10, appli fermée : plus rien ne passe).
 *
 * Le test d'équivalence évalue le filtre Prisma de la sélection sur toutes
 * les combinaisons d'état : une condition oubliée d'un côté ou de l'autre le
 * fait casser. Heures en UTC (= heure d'Abidjan).
 */
import {
  CourseOfferStatus,
  CourseStatut,
  DelivererStatus,
  EntityStatus,
} from '@prisma/client';

import { evaluer } from '../services/base-livreurs.simulee-spec';
import {
  APPLI_FERMEE_APRES_S_DEFAUT,
  ContexteAppli,
  EtatLivreur,
  FIN_PAUSE_INDEFINIE,
  SANS_REGLE_APPLI,
  SELECT_ETAT_LIVREUR,
  STATUTS_COURSE_EN_COURS,
  aUnJetonDeNotification,
  appliActiveDepuis,
  disponibiliteLivreur,
  estAppliActive,
  estEnPause,
  estEnPauseAuto,
  etatLivreurDepuis,
  filtreLivreursPouvantRecevoirOffre,
  heureLisible,
  idsSansJeton,
  injoignablesParmi,
  lireOffreJoignablesSeulement,
  messagePauseAuto,
  messageRefusOffre,
  peutRecevoirOffre,
} from './disponibilite.rules';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);
const apres = (min: number) => new Date(MAINTENANT.getTime() + min * 60_000);
const avantS = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);

const libre = (surcharge: Partial<EtatLivreur> = {}): EtatLivreur => ({
  status: DelivererStatus.ACTIVE,
  is_operational: true,
  entity_status: EntityStatus.ACTIVE,
  pause_until: null,
  auto_pause_until: null,
  last_available_at: avant(30),
  en_course: false,
  offre_en_attente: false,
  appli_active: true,
  ...surcharge,
});

describe('peutRecevoirOffre', () => {
  it('livreur en service, libre : oui', () => {
    expect(peutRecevoirOffre(libre(), MAINTENANT)).toEqual({ ok: true });
  });

  it('en pause : non, EN_PAUSE', () => {
    expect(peutRecevoirOffre(libre({ pause_until: apres(10) }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_PAUSE',
    });
  });

  it('pause « jusqu’à Reprendre » : non', () => {
    expect(peutRecevoirOffre(libre({ pause_until: FIN_PAUSE_INDEFINIE }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_PAUSE',
    });
  });

  it('pause automatique : non, PAUSE_AUTO', () => {
    expect(peutRecevoirOffre(libre({ auto_pause_until: apres(5) }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'PAUSE_AUTO',
    });
  });

  it('pause et pause automatique échues : oui (fin pile à maintenant comprise)', () => {
    expect(
      peutRecevoirOffre(libre({ pause_until: avant(1), auto_pause_until: MAINTENANT }), MAINTENANT),
    ).toEqual({ ok: true });
  });

  it('hors service (last_available_at nul) : non, HORS_SERVICE', () => {
    expect(peutRecevoirOffre(libre({ last_available_at: null }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'HORS_SERVICE',
    });
  });

  it('en course : non, EN_COURSE (avant HORS_SERVICE : accepter sort de la file)', () => {
    expect(
      peutRecevoirOffre(libre({ en_course: true, last_available_at: null }), MAINTENANT),
    ).toEqual({ ok: false, motif: 'EN_COURSE' });
  });

  it('appli fermée (24/10) : non, APPLI_FERMEE', () => {
    expect(peutRecevoirOffre(libre({ appli_active: false }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'APPLI_FERMEE',
    });
  });

  it('appli fermée : dite en dernier (pause, pause automatique, course, offre et hors service d’abord)', () => {
    const ferme = { appli_active: false };
    const cas: [Partial<EtatLivreur>, string][] = [
      [{ ...ferme, pause_until: apres(5) }, 'EN_PAUSE'],
      [{ ...ferme, auto_pause_until: apres(5) }, 'PAUSE_AUTO'],
      [{ ...ferme, en_course: true }, 'EN_COURSE'],
      [{ ...ferme, offre_en_attente: true }, 'OFFRE_EN_ATTENTE'],
      [{ ...ferme, last_available_at: null }, 'HORS_SERVICE'],
      [{ ...ferme, status: DelivererStatus.SUSPENDED }, 'INACTIF'],
    ];
    for (const [surcharge, motif] of cas) {
      expect(peutRecevoirOffre(libre(surcharge), MAINTENANT)).toEqual({ ok: false, motif });
    }
  });

  it('offre déjà en attente : non, OFFRE_EN_ATTENTE', () => {
    expect(peutRecevoirOffre(libre({ offre_en_attente: true }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'OFFRE_EN_ATTENTE',
    });
  });

  it.each([
    ['suspendu', { status: DelivererStatus.SUSPENDED }],
    ['non opérationnel', { is_operational: false }],
    ['compte inactif', { entity_status: EntityStatus.INACTIVE }],
    ['compte supprimé', { entity_status: EntityStatus.DELETED }],
  ])('%s : non, INACTIF', (_nom, surcharge) => {
    expect(peutRecevoirOffre(libre(surcharge as Partial<EtatLivreur>), MAINTENANT)).toEqual({
      ok: false,
      motif: 'INACTIF',
    });
  });

  it('priorité : la pause est dite avant la course et l’offre en attente', () => {
    expect(
      peutRecevoirOffre(
        libre({ pause_until: apres(5), en_course: true, offre_en_attente: true }),
        MAINTENANT,
      ),
    ).toEqual({ ok: false, motif: 'EN_PAUSE' });
  });

  it('estEnPause / estEnPauseAuto : fin strictement future', () => {
    expect(estEnPause({ pause_until: MAINTENANT }, MAINTENANT)).toBe(false);
    expect(estEnPause({ pause_until: apres(0.01) }, MAINTENANT)).toBe(true);
    expect(estEnPauseAuto({ auto_pause_until: null }, MAINTENANT)).toBe(false);
    expect(estEnPauseAuto({ auto_pause_until: apres(1) }, MAINTENANT)).toBe(true);
  });
});

describe('appli active ou fermée (demande du 24/10)', () => {
  const S = APPLI_FERMEE_APRES_S_DEFAUT;

  it('défaut : 180 secondes', () => {
    expect(S).toBe(180);
  });

  it('socket ouvert : active, quel que soit le signe de vie', () => {
    expect(estAppliActive({ socket_connecte: true, dernier_signal_at: null }, MAINTENANT, S)).toBe(true);
    expect(estAppliActive({ socket_connecte: true, dernier_signal_at: avant(60) }, MAINTENANT, S)).toBe(true);
  });

  it('sans socket : active avec un signe de vie de MOINS de 180 s (borne exclue)', () => {
    expect(estAppliActive({ socket_connecte: false, dernier_signal_at: avantS(10) }, MAINTENANT, S)).toBe(true);
    expect(estAppliActive({ socket_connecte: false, dernier_signal_at: avantS(179.999) }, MAINTENANT, S)).toBe(true);
    expect(estAppliActive({ socket_connecte: false, dernier_signal_at: avantS(180) }, MAINTENANT, S)).toBe(false);
    expect(estAppliActive({ socket_connecte: false, dernier_signal_at: avantS(600) }, MAINTENANT, S)).toBe(false);
    expect(estAppliActive({ socket_connecte: false, dernier_signal_at: null }, MAINTENANT, S)).toBe(false);
  });

  it('présence inconnue (Redis muet) : jugée sur le seul signe de vie', () => {
    expect(estAppliActive({ socket_connecte: null, dernier_signal_at: avantS(30) }, MAINTENANT, S)).toBe(true);
    expect(estAppliActive({ socket_connecte: null, dernier_signal_at: avantS(400) }, MAINTENANT, S)).toBe(false);
  });

  it('réglage à 0 (règle coupée) : toujours active', () => {
    expect(estAppliActive({ socket_connecte: false, dernier_signal_at: null }, MAINTENANT, 0)).toBe(true);
    expect(appliActiveDepuis({ id: 'l', dernier_signal_at: null, protocole_appli: 4 }, SANS_REGLE_APPLI, MAINTENANT)).toBe(true);
  });

  it('appli d’avant le protocole 4 (ou jamais vue) : la règle ne la vise pas, toujours active', () => {
    const contexte = { appliFermeeApresS: S, connectes: new Set<string>() };
    expect(appliActiveDepuis({ id: 'l', dernier_signal_at: avantS(4000), protocole_appli: 3 }, contexte, MAINTENANT)).toBe(true);
    expect(appliActiveDepuis({ id: 'l', dernier_signal_at: null, protocole_appli: null }, contexte, MAINTENANT)).toBe(true);
    expect(appliActiveDepuis({ id: 'l', dernier_signal_at: avantS(4000), protocole_appli: 4 }, contexte, MAINTENANT)).toBe(false);
  });

  it('appliActiveDepuis : le socket se lit dans `connectes`, null = inconnu', () => {
    const vieux = { id: 'l', dernier_signal_at: avantS(400), protocole_appli: 4 };
    expect(appliActiveDepuis(vieux, { appliFermeeApresS: S, connectes: new Set(['l']) }, MAINTENANT)).toBe(true);
    expect(appliActiveDepuis(vieux, { appliFermeeApresS: S, connectes: new Set(['autre']) }, MAINTENANT)).toBe(false);
    expect(appliActiveDepuis(vieux, { appliFermeeApresS: S, connectes: null }, MAINTENANT)).toBe(false);
  });

  it('etatLivreurDepuis : appli_active et appli_vue_a (dernier signe de vie)', () => {
    const ligne = {
      id: 'l',
      restaurant_id: 'r',
      status: DelivererStatus.ACTIVE,
      is_operational: true,
      entity_status: EntityStatus.ACTIVE,
      pause_until: null,
      auto_pause_until: null,
      last_available_at: avant(30),
      dernier_signal_at: avantS(200),
      protocole_appli: 4,
      _count: { courses: 0, offer_attempts: 0 },
    };
    const ferme = etatLivreurDepuis(ligne, { appliFermeeApresS: S, connectes: new Set() }, MAINTENANT);
    expect(ferme).toMatchObject({ appli_active: false, appli_vue_a: avantS(200) });
    expect(peutRecevoirOffre(ferme, MAINTENANT)).toEqual({ ok: false, motif: 'APPLI_FERMEE' });
    const enArrierePlan = etatLivreurDepuis({ ...ligne, dernier_signal_at: avantS(20) }, { appliFermeeApresS: S, connectes: new Set() }, MAINTENANT);
    expect(peutRecevoirOffre(enArrierePlan, MAINTENANT)).toEqual({ ok: true });
  });
});

describe('équivalence avec le filtre Prisma de la sélection', () => {
  const dates = [null, avant(5), MAINTENANT, apres(5)];
  const listesCourses: CourseStatut[][] = [
    [],
    [CourseStatut.COMPLETED],
    [CourseStatut.PENDING_ASSIGNMENT],
    [CourseStatut.ACCEPTED],
    [CourseStatut.AT_RESTAURANT],
    [CourseStatut.IN_DELIVERY],
    [CourseStatut.CANCELLED, CourseStatut.IN_DELIVERY],
  ];
  const listesOffres: { status: CourseOfferStatus; expires_at: Date }[][] = [
    [],
    [{ status: CourseOfferStatus.PENDING, expires_at: apres(1) }],
    // Échue mais pas encore traitée par la tâche : compte encore.
    [{ status: CourseOfferStatus.PENDING, expires_at: avant(1) }],
    [{ status: CourseOfferStatus.EXPIRED, expires_at: avant(1) }],
    [{ status: CourseOfferStatus.CANCELLED, expires_at: apres(1) }],
    [{ status: CourseOfferStatus.ACCEPTED, expires_at: apres(1) }],
  ];

  const filtreCourses = SELECT_ETAT_LIVREUR._count.select.courses.where;
  const filtreOffres = SELECT_ETAT_LIVREUR._count.select.offer_attempts.where;

  /** Compare la règle et le filtre sur une ligne ; rend la décision de la règle. */
  function comparer(ligne: Record<string, any>, appli: ContexteAppli, filtre: Record<string, any>) {
    // L'état de la règle, lu comme le ferait SELECT_ETAT_LIVREUR.
    const etat = etatLivreurDepuis(
      {
        ...(ligne as any),
        restaurant_id: 'r',
        _count: {
          courses: ligne.courses.filter((c: any) => evaluer(c, filtreCourses)).length,
          offer_attempts: ligne.offer_attempts.filter((o: any) => evaluer(o, filtreOffres)).length,
        },
      },
      appli,
      MAINTENANT,
    );
    const decision = peutRecevoirOffre(etat, MAINTENANT);
    const prisma = evaluer(ligne, filtre);
    if (decision.ok !== prisma) {
      const contexte = { ...appli, connectes: appli.connectes && [...appli.connectes] };
      throw new Error(`Divergence règle=${decision.ok} filtre=${prisma} pour ${JSON.stringify({ ligne, contexte })}`);
    }
    return decision;
  }

  it('mêmes décisions sur toutes les combinaisons (règle de l’appli coupée)', () => {
    const filtre = filtreLivreursPouvantRecevoirOffre(MAINTENANT, SANS_REGLE_APPLI);
    let essais = 0;
    let acceptes = 0;

    for (const status of [DelivererStatus.ACTIVE, DelivererStatus.SUSPENDED])
      for (const is_operational of [true, false])
        for (const entity_status of [EntityStatus.ACTIVE, EntityStatus.INACTIVE])
          for (const pause_until of dates)
            for (const auto_pause_until of dates)
              for (const last_available_at of [null, avant(30)])
                for (const statuts of listesCourses)
                  for (const offres of listesOffres) {
                    const ligne = {
                      id: 'l',
                      status,
                      is_operational,
                      entity_status,
                      pause_until,
                      auto_pause_until,
                      last_available_at,
                      dernier_signal_at: null,
                      courses: statuts.map((statut) => ({ statut })),
                      offer_attempts: offres,
                    };
                    essais++;
                    if (comparer(ligne, SANS_REGLE_APPLI, filtre).ok) acceptes++;
                  }

    expect(essais).toBe(2 * 2 * 2 * 4 * 4 * 2 * 7 * 6);
    // Garde-fou : le test a bien vu des livreurs acceptés et refusés.
    expect(acceptes).toBeGreaterThan(0);
    expect(acceptes).toBeLessThan(essais);
  });

  it('appli (24/10) : mêmes décisions pour tout signe de vie, socket et réglage', () => {
    // Signe de vie absent, récent, juste avant le seuil, pile au seuil, vieux ;
    // socket ouvert, fermé, présence inconnue ; réglage à 180 s, coupé.
    const signaux = [null, avantS(10), avantS(179.999), avantS(180), avantS(1800)];
    const contextes: ContexteAppli[] = [];
    for (const appliFermeeApresS of [180, 0])
      for (const connectes of [new Set(['l']), new Set<string>(), null]) contextes.push({ appliFermeeApresS, connectes });
    const comptes: { status: DelivererStatus; is_operational: boolean }[] = [
      { status: DelivererStatus.ACTIVE, is_operational: true },
      { status: DelivererStatus.SUSPENDED, is_operational: true },
      { status: DelivererStatus.ACTIVE, is_operational: false },
    ];
    let essais = 0;
    let acceptes = 0;
    let refusesAppliFermee = 0;

    for (const appli of contextes) {
      const filtre = filtreLivreursPouvantRecevoirOffre(MAINTENANT, appli);
      for (const compte of comptes)
        for (const pause_until of dates)
          for (const auto_pause_until of [null, apres(5)])
            for (const last_available_at of [null, avant(30)])
              for (const dernier_signal_at of signaux)
                for (const protocole_appli of [null, 3, 4, 5])
                for (const statuts of [[], [CourseStatut.ACCEPTED], [CourseStatut.COMPLETED]])
                  for (const offres of [listesOffres[0], listesOffres[1], listesOffres[3]]) {
                    const ligne = {
                      id: 'l',
                      ...compte,
                      entity_status: EntityStatus.ACTIVE,
                      pause_until,
                      auto_pause_until,
                      last_available_at,
                      dernier_signal_at,
                      protocole_appli,
                      courses: statuts.map((statut) => ({ statut })),
                      offer_attempts: offres,
                    };
                    const decision = comparer(ligne, appli, filtre);
                    essais++;
                    if (decision.ok) acceptes++;
                    if (!decision.ok && decision.motif === 'APPLI_FERMEE') refusesAppliFermee++;
                  }
    }

    expect(essais).toBe(6 * 3 * 4 * 2 * 2 * 5 * 4 * 3 * 3);
    // Garde-fou : acceptés, refusés, et refusés pour l'appli fermée.
    expect(acceptes).toBeGreaterThan(0);
    expect(acceptes).toBeLessThan(essais);
    expect(refusesAppliFermee).toBeGreaterThan(0);
  });

  it('réglage coupé : le filtre ne regarde ni le signe de vie ni les sockets', () => {
    expect(JSON.stringify(filtreLivreursPouvantRecevoirOffre(MAINTENANT, SANS_REGLE_APPLI))).not.toMatch(
      /dernier_signal_at/,
    );
  });

  it('aucun socket connu : pas de liste d’ids vide dans le filtre', () => {
    const filtre = JSON.stringify(
      filtreLivreursPouvantRecevoirOffre(MAINTENANT, { appliFermeeApresS: 180, connectes: new Set() }),
    );
    expect(filtre).toMatch(/dernier_signal_at/);
    expect(filtre).not.toMatch(/"in":\[\]/);
  });

  it('les courses qui occupent un livreur sont acceptée, au restaurant, en livraison', () => {
    expect(STATUTS_COURSE_EN_COURS).toEqual([
      CourseStatut.ACCEPTED,
      CourseStatut.AT_RESTAURANT,
      CourseStatut.IN_DELIVERY,
    ]);
  });
});

describe('textes', () => {
  it('heure lisible le même jour, puis un autre jour', () => {
    expect(heureLisible(new Date('2026-10-22T14:32:00.000Z'), MAINTENANT)).toBe('14 h 32');
    expect(heureLisible(new Date('2026-10-22T09:05:00.000Z'), MAINTENANT)).toBe('9 h 05');
    expect(heureLisible(new Date('2026-10-23T00:10:00.000Z'), MAINTENANT)).toBe(
      'le 23/10 à 0 h 10',
    );
  });

  it('affectation forcée refusée : la raison, avec l’heure de fin', () => {
    const etat = { pause_until: new Date('2026-10-22T14:32:00.000Z'), auto_pause_until: null };
    expect(messageRefusOffre('EN_PAUSE', etat, MAINTENANT)).toBe(
      "Ce livreur est en pause jusqu'à 14 h 32.",
    );
    expect(
      messageRefusOffre('EN_PAUSE', { pause_until: FIN_PAUSE_INDEFINIE, auto_pause_until: null }, MAINTENANT),
    ).toBe('Ce livreur est en pause.');
    expect(
      messageRefusOffre(
        'PAUSE_AUTO',
        { pause_until: null, auto_pause_until: new Date('2026-10-23T08:00:00.000Z') },
        MAINTENANT,
      ),
    ).toBe("Ce livreur est en pause automatique jusqu'au 23/10 à 8 h 00.");
    expect(messageRefusOffre('EN_COURSE', etat, MAINTENANT)).toBe(
      'Ce livreur a déjà une course en cours.',
    );
    expect(messageRefusOffre('OFFRE_EN_ATTENTE', etat, MAINTENANT)).toBe(
      'Ce livreur a déjà une offre en attente de réponse.',
    );
    expect(messageRefusOffre('HORS_SERVICE', etat, MAINTENANT)).toBe(
      "Ce livreur est hors service : il n'a pas repris le travail dans l'appli.",
    );
    expect(messageRefusOffre('APPLI_FERMEE', etat, MAINTENANT)).toBe("L'appli de ce livreur est fermée.");
  });

  it('« Reprendre » pendant une pause automatique', () => {
    expect(messagePauseAuto(new Date('2026-10-22T14:32:00.000Z'), MAINTENANT)).toBe(
      "Pause automatique jusqu'à 14 h 32.",
    );
  });

  it('aucun tiret cadratin dans les textes', () => {
    const etat = { pause_until: apres(5), auto_pause_until: apres(5) };
    const textes = (
      ['INACTIF', 'EN_PAUSE', 'PAUSE_AUTO', 'EN_COURSE', 'OFFRE_EN_ATTENTE', 'HORS_SERVICE', 'APPLI_FERMEE', 'INJOIGNABLE'] as const
    ).map((m) => messageRefusOffre(m, etat, MAINTENANT));
    textes.push(messagePauseAuto(apres(5), MAINTENANT));
    for (const t of textes) expect(t).not.toMatch(/[—–]/);
  });
});

describe('disponibiliteLivreur (affichage au backoffice)', () => {
  it('l’état affiché est celui que le serveur appliquerait, avec un libellé prêt à afficher', () => {
    const cas: [Partial<EtatLivreur>, string, string][] = [
      [{}, 'DISPONIBLE', 'Disponible'],
      [{ pause_until: new Date('2026-10-22T14:32:00.000Z'), last_available_at: null }, 'EN_PAUSE', "En pause jusqu'à 14 h 32"],
      [{ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null }, 'EN_PAUSE', 'En pause'],
      [{ auto_pause_until: new Date('2026-10-23T08:05:00.000Z') }, 'PAUSE_AUTO', "Pause automatique jusqu'au 23/10 à 8 h 05"],
      [{ en_course: true, last_available_at: null }, 'EN_COURSE', 'En course'],
      [{ offre_en_attente: true }, 'OFFRE_EN_ATTENTE', 'Offre en attente'],
      [{ last_available_at: null }, 'HORS_SERVICE', 'Hors service'],
      [{ status: DelivererStatus.SUSPENDED }, 'INACTIF', 'Inactif'],
      [{ appli_active: false }, 'APPLI_FERMEE', 'Appli fermée'],
    ];
    for (const [surcharge, etat, libelle] of cas) {
      expect([etat, disponibiliteLivreur(libre(surcharge), MAINTENANT).libelle]).toEqual([etat, libelle]);
      expect(disponibiliteLivreur(libre(surcharge), MAINTENANT).etat).toBe(etat);
    }
  });

  it('champs bruts et raison du refus, comme le 409 de l’affectation forcée', () => {
    const pause = new Date('2026-10-22T14:32:00.000Z');
    expect(disponibiliteLivreur(libre({ pause_until: pause, last_available_at: null }), MAINTENANT)).toEqual({
      etat: 'EN_PAUSE',
      libelle: "En pause jusqu'à 14 h 32",
      peut_recevoir_offre: false,
      message_refus: "Ce livreur est en pause jusqu'à 14 h 32.",
      en_pause: true,
      en_pause_auto: false,
      pause_until: pause,
      auto_pause_until: null,
      en_service: false,
      en_course: false,
      offre_en_attente: false,
      offre_course_id: null,
      appli_active: true,
      appli_vue_a: null,
    });
    expect(disponibiliteLivreur(libre({ offre_en_attente: true }), MAINTENANT, 'c1')).toMatchObject({
      peut_recevoir_offre: false,
      offre_course_id: 'c1',
      message_refus: 'Ce livreur a déjà une offre en attente de réponse.',
    });
    expect(disponibiliteLivreur(libre(), MAINTENANT, 'c1')).toMatchObject({
      peut_recevoir_offre: true,
      message_refus: null,
      offre_course_id: null,
    });
  });

  it('appli fermée (24/10) : « Appli fermée », le refus de l’affectation forcée, et l’heure du dernier signe de vie', () => {
    const vue = avantS(400);
    expect(disponibiliteLivreur(libre({ appli_active: false, appli_vue_a: vue }), MAINTENANT)).toMatchObject({
      etat: 'APPLI_FERMEE',
      libelle: 'Appli fermée',
      peut_recevoir_offre: false,
      message_refus: "L'appli de ce livreur est fermée.",
      en_service: true,
      appli_active: false,
      appli_vue_a: vue,
    });
  });

  it('appli active en arrière-plan, en course : l’état reste celui de la règle, appli_active à vrai', () => {
    expect(disponibiliteLivreur(libre({ en_course: true, appli_vue_a: avantS(20) }), MAINTENANT)).toMatchObject({
      etat: 'EN_COURSE',
      appli_active: true,
      appli_vue_a: avantS(20),
    });
  });
});

/**
 * LIVREUR JOIGNABLE (défaut signalé le 24/10 : « proposée » au backoffice,
 * rien reçu par le livreur) : socket ouvert OU jeton de notification. Sinon
 * passé, comme s'il n'était pas disponible, sans pause ni pénalité.
 */
describe('joignable : socket ouvert ou jeton de notification', () => {
  it('réglage `course.offre_joignables_seulement` : 1 par défaut, 0 coupe la règle', () => {
    expect(lireOffreJoignablesSeulement(undefined)).toBe(true);
    expect(lireOffreJoignablesSeulement('')).toBe(true);
    expect(lireOffreJoignablesSeulement('1')).toBe(true);
    expect(lireOffreJoignablesSeulement('true')).toBe(true);
    expect(lireOffreJoignablesSeulement('0')).toBe(false);
    expect(lireOffreJoignablesSeulement('false')).toBe(false);
  });

  it('jeton utilisable : une chaîne non vide', () => {
    expect(aUnJetonDeNotification('ExponentPushToken[abc]')).toBe(true);
    expect(aUnJetonDeNotification(null)).toBe(false);
    expect(aUnJetonDeNotification(undefined)).toBe(false);
    expect(aUnJetonDeNotification('  ')).toBe(false);
  });

  it('injoignable : jeton lu et absent, aucun socket ; jeton non lu : non jugé ; présence inconnue : personne', () => {
    const lignes = [
      { id: 'jeton', expo_push_token: 'ExponentPushToken[abc]' },
      { id: 'socket', expo_push_token: null },
      { id: 'rien', expo_push_token: null },
      { id: 'vide', expo_push_token: '' },
      { id: 'non-lu' },
    ];
    expect(idsSansJeton(lignes)).toEqual(['socket', 'rien', 'vide']);
    expect([...injoignablesParmi(lignes, new Set(['socket']))!]).toEqual(['rien', 'vide']);
    expect(injoignablesParmi(lignes, null)).toBeNull();
  });

  it('peutRecevoirOffre : injoignable, non, INJOIGNABLE, dit en dernier ; non jugé : oui', () => {
    expect(peutRecevoirOffre(libre({ joignable: false }), MAINTENANT)).toEqual({ ok: false, motif: 'INJOIGNABLE' });
    expect(peutRecevoirOffre(libre({ joignable: true }), MAINTENANT)).toEqual({ ok: true });
    expect(peutRecevoirOffre(libre(), MAINTENANT)).toEqual({ ok: true });
    expect(peutRecevoirOffre(libre({ joignable: false, appli_active: false }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'APPLI_FERMEE',
    });
    expect(peutRecevoirOffre(libre({ joignable: false, last_available_at: null }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'HORS_SERVICE',
    });
  });

  it('etatLivreurDepuis : `joignable` lu dans `injoignables`, absent quand la règle n’a rien jugé', () => {
    const ligne = {
      id: 'l',
      restaurant_id: 'r',
      status: DelivererStatus.ACTIVE,
      is_operational: true,
      entity_status: EntityStatus.ACTIVE,
      pause_until: null,
      auto_pause_until: null,
      last_available_at: avant(30),
      dernier_signal_at: null,
      protocole_appli: 4,
      _count: { courses: 0, offer_attempts: 0 },
    };
    expect(etatLivreurDepuis(ligne, SANS_REGLE_APPLI, MAINTENANT)).not.toHaveProperty('joignable');
    expect(etatLivreurDepuis(ligne, { ...SANS_REGLE_APPLI, injoignables: null }, MAINTENANT)).not.toHaveProperty('joignable');
    expect(etatLivreurDepuis(ligne, { ...SANS_REGLE_APPLI, injoignables: new Set(['l']) }, MAINTENANT).joignable).toBe(false);
    expect(etatLivreurDepuis(ligne, { ...SANS_REGLE_APPLI, injoignables: new Set(['x']) }, MAINTENANT).joignable).toBe(true);
  });

  it('équivalence avec le filtre Prisma : mêmes décisions, injoignable ou non, avec ou sans règle de l’appli', () => {
    const filtreCourses = SELECT_ETAT_LIVREUR._count.select.courses.where;
    const filtreOffres = SELECT_ETAT_LIVREUR._count.select.offer_attempts.where;
    const contextes: ContexteAppli[] = [];
    for (const appli of [SANS_REGLE_APPLI, { appliFermeeApresS: 180, connectes: new Set<string>() }])
      for (const injoignables of [new Set(['l']), new Set(['autre']), new Set<string>(), null, undefined])
        contextes.push({ ...appli, injoignables });
    let essais = 0;
    let refusesInjoignable = 0;
    for (const appli of contextes) {
      const filtre = filtreLivreursPouvantRecevoirOffre(MAINTENANT, appli);
      for (const pause_until of [null, apres(5)])
        for (const last_available_at of [null, avant(30)])
          for (const dernier_signal_at of [null, avantS(10)])
            for (const offres of [[], [{ status: CourseOfferStatus.PENDING, expires_at: apres(1) }]]) {
              const ligne = {
                id: 'l',
                status: DelivererStatus.ACTIVE,
                is_operational: true,
                entity_status: EntityStatus.ACTIVE,
                pause_until,
                auto_pause_until: null,
                last_available_at,
                dernier_signal_at,
                protocole_appli: 4,
                courses: [] as { statut: CourseStatut }[],
                offer_attempts: offres,
              };
              const etat = etatLivreurDepuis(
                {
                  ...ligne,
                  restaurant_id: 'r',
                  _count: {
                    courses: ligne.courses.filter((c) => evaluer(c, filtreCourses)).length,
                    offer_attempts: ligne.offer_attempts.filter((o) => evaluer(o, filtreOffres)).length,
                  },
                },
                appli,
                MAINTENANT,
              );
              const decision = peutRecevoirOffre(etat, MAINTENANT);
              expect([decision.ok, JSON.stringify(ligne)]).toEqual([evaluer(ligne, filtre), JSON.stringify(ligne)]);
              essais++;
              if (!decision.ok && decision.motif === 'INJOIGNABLE') refusesInjoignable++;
            }
    }
    expect(essais).toBe(10 * 2 * 2 * 2 * 2);
    expect(refusesInjoignable).toBeGreaterThan(0);
  });

  it('aucun injoignable connu : pas de liste d’ids vide dans le filtre', () => {
    const filtre = JSON.stringify(
      filtreLivreursPouvantRecevoirOffre(MAINTENANT, { ...SANS_REGLE_APPLI, injoignables: new Set() }),
    );
    expect(filtre).not.toMatch(/notIn/);
  });

  it('backoffice : « Injoignable », et le refus de l’affectation forcée', () => {
    expect(disponibiliteLivreur(libre({ joignable: false }), MAINTENANT)).toMatchObject({
      etat: 'INJOIGNABLE',
      libelle: 'Injoignable',
      peut_recevoir_offre: false,
      message_refus: 'Ce livreur est injoignable : ni appli connectée, ni notifications.',
      en_service: true,
    });
  });
});
