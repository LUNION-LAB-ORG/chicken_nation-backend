/**
 * OFFRE AUX SEULS LIVREURS JOIGNABLES (défaut signalé le 24/10 : « au niveau
 * du backoffice on nous dit que la course est proposée au livreur pourtant le
 * livreur ne reçoit rien »).
 *
 * Joignable : un socket ouvert dans sa salle `deliverer_{id}`, OU un jeton de
 * notification. Un livreur sans l'un ni l'autre est passé pour cette offre,
 * comme s'il n'était pas disponible, sans pause ni pénalité ; il redevient
 * candidat dès qu'il est joignable. Réglage `course.offre_joignables_seulement`
 * (défaut 1, 0 = ancien comportement). Une offre déjà partie garde ses
 * relances, son échéance et sa pénalité (décision du client encore ouverte).
 *
 * Les VRAIS services (planificateur v2, offres, gardes, appli du livreur) sur
 * la base simulée (banc-planificateur.simulee-spec.ts).
 */
import { ConflictException } from '@nestjs/common';
import { CourseOfferStatus } from '@prisma/client';

import { course, livraison, livreur, offre } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, LOIN, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
});

const enAttente = (t: ReturnType<typeof monter>) =>
  t.base.offres.filter((o) => o.status === CourseOfferStatus.PENDING).map((o) => o.deliverer_id);

describe('joignable : l’offre part', () => {
  it('par socket : sans jeton de notification, l’appli ouverte suffit', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [l.id] } });

    await t.passer();

    expect(enAttente(t)).toEqual([l.id]);
  });

  it('par notification seule : iOS en arrière-plan (positions, socket suspendu), jeton valide', async () => {
    const l = livreur({ ...AU_COMPTOIR, protocole_appli: 4, dernier_signal_at: avant(40) });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [] } });

    await t.passer();

    expect(enAttente(t)).toEqual([l.id]);
    expect(t.push.notifyNewCourseOffer).toHaveBeenCalledWith(expect.objectContaining({ delivererId: l.id }));
  });
});

describe('injoignable (ni socket, ni jeton) : passé, sans pénalité', () => {
  it('au comptoir mais injoignable : l’offre part au livreur joignable ; lui ne perd rien', async () => {
    const injoignable = livreur({ ...AU_COMPTOIR, expo_push_token: null, last_available_at: avant(3600) });
    const joignable = livreur({ ...LOIN, last_available_at: avant(60) });
    const t = monter({ commandes: [prete()], livreurs: [injoignable, joignable] }, { appli: { connectes: [] } });

    await t.passer();

    expect(enAttente(t)).toEqual([joignable.id]);
    // Aucune trace d'offre pour lui : il reste candidat pour cette course.
    expect(t.base.offres.some((o) => o.deliverer_id === injoignable.id)).toBe(false);
    // Ni pause, ni sortie de la file, ni pénalité de file, ni refus compté.
    expect(injoignable.pause_until).toBeNull();
    expect(injoignable.last_available_at).toEqual(avant(3600));
    expect(injoignable.queue_penalty_until).toBeNull();
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(t.queue.onRefuse).not.toHaveBeenCalled();
    expect(t.coursesOuvertes()[0].refusal_count ?? 0).toBe(0);
    expect(t.push.notifyNewCourseOffer).not.toHaveBeenCalledWith(expect.objectContaining({ delivererId: injoignable.id }));
  });

  it('seul livreur et injoignable : la course attend, aucune offre « proposée » pour rien', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [] } });

    await t.passer();

    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.base.offres).toHaveLength(0);
    expect(t.coursesOuvertes()[0].offer_expires_at ?? null).toBeNull();
  });

  it('affectation forcée : refusée avec la raison, écrite au journal', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const k = course({ created_at: avant(30) });
    const a = prete();
    const t = monter(
      { commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 })], livreurs: [l] },
      { appli: { connectes: [] } },
    );

    const refus = t.garde.verifierAffectationForcee(k.id, l.id, MAINTENANT);
    await expect(refus).rejects.toBeInstanceOf(ConflictException);
    await expect(t.garde.verifierAffectationForcee(k.id, l.id, MAINTENANT)).rejects.toThrow(
      'Ce livreur est injoignable : ni appli connectée, ni notifications.',
    );
    expect(t.journalDe('AFFECTATION_FORCEE_REFUSEE')[0]).toMatchObject({
      motif: 'INJOIGNABLE',
      deliverer_id: l.id,
      details: expect.objectContaining({ jeton_notification: false }),
    });
  });

  it('création directe (sélection v1, relance de la recherche) : refusée sous le verrou, rien n’est écrit', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const k = course({ created_at: avant(30) });
    const a = prete();
    const t = monter(
      { commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 })], livreurs: [l] },
      { appli: { connectes: [] } },
    );

    expect(await t.offres.offerToDeliverer(k.id, l.id)).toBe(false);
    expect(t.base.offres).toHaveLength(0);
    expect(t.push.notifyNewCourseOffer).not.toHaveBeenCalled();
  });
});

describe('il redevient joignable : candidat au passage suivant', () => {
  it('l’appli se connecte (socket) : l’offre lui part', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [] } });

    await t.passer();
    expect(t.base.offres).toHaveLength(0);

    t.appli.etat.connectes = [l.id];
    await t.passer();
    expect(enAttente(t)).toEqual([l.id]);
  });

  it('les notifications reviennent (jeton enregistré) : l’offre lui part', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [] } });

    await t.passer();
    expect(t.base.offres).toHaveLength(0);

    l.expo_push_token = 'ExponentPushToken[nouveau]';
    await t.passer();
    expect(enAttente(t)).toEqual([l.id]);
  });
});

describe('réglage et présence inconnue : l’ancien comportement', () => {
  it('`course.offre_joignables_seulement` à 0 : l’offre part même au livreur injoignable', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [], joignablesSeulement: false } });

    await t.passer();

    expect(enAttente(t)).toEqual([l.id]);
  });

  it('réglage à 0 : l’affectation forcée passe', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const k = course({ created_at: avant(30) });
    const a = prete();
    const t = monter(
      { commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 })], livreurs: [l] },
      { appli: { connectes: [], joignablesSeulement: false } },
    );

    await expect(t.garde.verifierAffectationForcee(k.id, l.id, MAINTENANT)).resolves.toEqual({ renvoi: false });
  });

  it('présence inconnue (Redis ou l’autre serveur muet) : personne n’est réputé injoignable', async () => {
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: null } });

    await t.passer();

    expect(enAttente(t)).toEqual([l.id]);
  });
});

describe('offre déjà partie : délais et pénalités inchangés (décision du client encore ouverte)', () => {
  function monterOffre() {
    const a = prete();
    const k = course({ created_at: avant(60) });
    // Devenu injoignable pendant l'offre : plus de socket, jeton effacé.
    const l = livreur({ ...AU_COMPTOIR, expo_push_token: null });
    const o = offre({ course_id: k.id, deliverer_id: l.id, offered_at: avant(40), expires_at: apres(80) });
    const t = monter(
      {
        commandes: [a],
        courses: [k],
        livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 })],
        livreurs: [l],
        offres: [o],
      },
      { appli: { connectes: [] } },
    );
    return { t, k, l, o };
  }

  it('relance à 30 s : envoyée comme avant, l’offre reste en attente', async () => {
    const { t, l, o } = monterOffre();

    expect(await t.offres.remindPendingOffers()).toBe(1);

    expect(o.status).toBe(CourseOfferStatus.PENDING);
    expect(t.push.notifyCourseOfferReminder).toHaveBeenCalledWith(expect.objectContaining({ delivererId: l.id }));
  });

  it('échéance : expirée et pénalisée comme avant', async () => {
    const { t, k, l, o } = monterOffre();
    o.offered_at = avant(121);
    o.expires_at = avant(1);

    await t.offres.expirePendingOffers();

    expect(o.status).toBe(CourseOfferStatus.EXPIRED);
    expect(t.queue.onOfferExpired).toHaveBeenCalledWith(l.id);
    expect(k.refusal_count).toBe(1);
  });
});
