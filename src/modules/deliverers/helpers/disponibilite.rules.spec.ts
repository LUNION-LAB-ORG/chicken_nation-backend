/**
 * Règle unique : un livreur peut-il recevoir une offre ? (demande du 22/10,
 * « un livreur en pause ne doit pas recevoir de commandes »).
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
  EtatLivreur,
  FIN_PAUSE_INDEFINIE,
  SELECT_ETAT_LIVREUR,
  STATUTS_COURSE_EN_COURS,
  disponibiliteLivreur,
  estEnPause,
  estEnPauseAuto,
  etatLivreurDepuis,
  filtreLivreursPouvantRecevoirOffre,
  heureLisible,
  messagePauseAuto,
  messageRefusOffre,
  peutRecevoirOffre,
} from './disponibilite.rules';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);
const apres = (min: number) => new Date(MAINTENANT.getTime() + min * 60_000);

const libre = (surcharge: Partial<EtatLivreur> = {}): EtatLivreur => ({
  status: DelivererStatus.ACTIVE,
  is_operational: true,
  entity_status: EntityStatus.ACTIVE,
  pause_until: null,
  auto_pause_until: null,
  last_available_at: avant(30),
  en_course: false,
  offre_en_attente: false,
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

  it('mêmes décisions sur toutes les combinaisons', () => {
    const filtre = filtreLivreursPouvantRecevoirOffre(MAINTENANT);
    const filtreCourses = SELECT_ETAT_LIVREUR._count.select.courses.where;
    const filtreOffres = SELECT_ETAT_LIVREUR._count.select.offer_attempts.where;
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
                      status,
                      is_operational,
                      entity_status,
                      pause_until,
                      auto_pause_until,
                      last_available_at,
                      courses: statuts.map((statut) => ({ statut })),
                      offer_attempts: offres,
                    };
                    // L'état de la règle, lu comme le ferait SELECT_ETAT_LIVREUR.
                    const etat = etatLivreurDepuis({
                      ...ligne,
                      id: 'l',
                      restaurant_id: 'r',
                      _count: {
                        courses: ligne.courses.filter((c) => evaluer(c, filtreCourses)).length,
                        offer_attempts: ligne.offer_attempts.filter((o) => evaluer(o, filtreOffres))
                          .length,
                      },
                    });
                    const regle = peutRecevoirOffre(etat, MAINTENANT).ok;
                    const prisma = evaluer(ligne, filtre);
                    if (regle !== prisma) {
                      throw new Error(
                        `Divergence règle=${regle} filtre=${prisma} pour ${JSON.stringify(ligne)}`,
                      );
                    }
                    essais++;
                    if (regle) acceptes++;
                  }

    expect(essais).toBe(2 * 2 * 2 * 4 * 4 * 2 * 7 * 6);
    // Garde-fou : le test a bien vu des livreurs acceptés et refusés.
    expect(acceptes).toBeGreaterThan(0);
    expect(acceptes).toBeLessThan(essais);
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
  });

  it('« Reprendre » pendant une pause automatique', () => {
    expect(messagePauseAuto(new Date('2026-10-22T14:32:00.000Z'), MAINTENANT)).toBe(
      "Pause automatique jusqu'à 14 h 32.",
    );
  });

  it('aucun tiret cadratin dans les textes', () => {
    const etat = { pause_until: apres(5), auto_pause_until: apres(5) };
    const textes = (
      ['INACTIF', 'EN_PAUSE', 'PAUSE_AUTO', 'EN_COURSE', 'OFFRE_EN_ATTENTE', 'HORS_SERVICE'] as const
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
});
