/**
 * Bus interne de la diffusion : journal des offres, filet « hors service sans
 * signal » à l'expiration, relance de la recherche après une clôture, offre
 * en attente renvoyée au livreur (route et connexion du socket).
 */
import { CourseOfferStatus, CourseStatut } from '@prisma/client';

import {
  course,
  livreur,
  monterBase,
  offre,
} from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { CourseChannels } from '../enums/course-channels';
import { CourseOfferService } from '../services/course-offer.service';
import { DispatchJournalService } from '../services/dispatch-journal.service';
import { OffreEnAttenteService } from '../services/offre-en-attente.service';
import { DispatchListener } from './dispatch.listener';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);
const apres = (s: number) => new Date(MAINTENANT.getTime() + s * 1000);

function monter(donnees: Parameters<typeof monterBase>[0] = {}) {
  const base = monterBase(donnees);
  const journal = new DispatchJournalService(base.prisma);
  const offreEnAttente = new OffreEnAttenteService(base.prisma);
  const offres = { offerNextDeliverer: jest.fn(async () => undefined) };
  const disponibilite = { mettreHorsServiceSiSansSignal: jest.fn(async () => false) };
  const gateway = { emitToDeliverer: jest.fn() };
  const cloture = { clorePourCourse: jest.fn(async () => []) };
  const queue = { remettreEnFile: jest.fn(async () => true) };
  const ecouteur = new DispatchListener(
    base.prisma,
    offres as never,
    offreEnAttente,
    journal,
    disponibilite as never,
    gateway as never,
    cloture as never,
    queue as never,
  );
  return { ...base, ecouteur, offres, disponibilite, gateway, offreEnAttente, cloture, queue };
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

describe('journal des offres', () => {
  it('offre proposée : une ligne ; nouvel envoi de la même offre : rien de plus', async () => {
    const c = course();
    const t = monter({ courses: [c] });
    const charge = {
      course: { ...c, deliveries: [{}, {}] } as never,
      deliverer_id: 'livreur-1',
      offer_id: c.id,
      expires_at: apres(120),
    };

    await t.ecouteur.onOffreProposee(charge);
    await t.ecouteur.onOffreProposee({ ...charge, renvoi: true });

    expect(t.journal).toHaveLength(1);
    expect(t.journal[0]).toMatchObject({
      type: 'OFFRE_PROPOSEE',
      course_id: c.id,
      deliverer_id: 'livreur-1',
      restaurant_id: c.restaurant_id,
      details: { course: c.reference, expire: apres(120).toISOString(), livraisons: 2 },
    });
  });

  it('offre acceptée et refusée', async () => {
    const c = course({ deliverer_id: 'livreur-1' });
    const t = monter({ courses: [c] });

    await t.ecouteur.onOffreAcceptee({ course: c as never });
    await t.ecouteur.onOffreRefusee({ course_id: c.id, deliverer_id: 'livreur-2', raison: 'Trop loin' });

    expect(t.journal.map((l) => [l.type, l.deliverer_id, l.restaurant_id])).toEqual([
      ['OFFRE_ACCEPTEE', 'livreur-1', c.restaurant_id],
      ['OFFRE_REFUSEE', 'livreur-2', c.restaurant_id],
    ]);
    expect(t.journal[1].details).toEqual({ course: c.reference, raison: 'Trop loin' });
  });

  it('offre expirée : journal et filet « hors service sans signal »', async () => {
    const c = course();
    const t = monter({ courses: [c] });

    await t.ecouteur.onOffreExpiree({ course_id: c.id, deliverer_id: 'livreur-1', motif: 'EXPIREE' });

    expect(t.journal[0]).toMatchObject({ type: 'OFFRE_EXPIREE', course_id: c.id, restaurant_id: c.restaurant_id });
    expect(t.disponibilite.mettreHorsServiceSiSansSignal).toHaveBeenCalledWith('livreur-1');
  });

  it('offre close par le serveur : déjà journalisée par la clôture, pas de filet', async () => {
    const t = monter();
    await t.ecouteur.onOffreExpiree({ course_id: 'c', deliverer_id: 'livreur-1', motif: 'LIVREUR_EN_PAUSE' });
    expect(t.journal).toEqual([]);
    expect(t.disponibilite.mettreHorsServiceSiSansSignal).not.toHaveBeenCalled();
  });

  it('un filet en erreur ne remonte pas', async () => {
    const t = monter({ courses: [course({ id: 'c' })] });
    t.disponibilite.mettreHorsServiceSiSansSignal.mockRejectedValue(new Error('panne'));
    await expect(
      t.ecouteur.onOffreExpiree({ course_id: 'c', deliverer_id: 'l', motif: 'EXPIREE' }),
    ).resolves.toBeUndefined();
  });
});

describe('relance de la recherche après une clôture', () => {
  it('appelle offerNextDeliverer, et avale ses erreurs', async () => {
    const t = monter();
    await t.ecouteur.onRechercheARelancer({ course_id: 'course-1' });
    expect(t.offres.offerNextDeliverer).toHaveBeenCalledWith('course-1');

    t.offres.offerNextDeliverer.mockRejectedValueOnce(new Error('panne'));
    await expect(t.ecouteur.onRechercheARelancer({ course_id: 'course-1' })).resolves.toBeUndefined();
  });
});

describe('offre en attente du livreur', () => {
  it('rend l’offre valable, sous la forme de course:offer:new', async () => {
    const l = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: l.id, expires_at: apres(60) });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    expect(await t.offreEnAttente.pourLivreur(l.id)).toEqual({
      offer_id: c.id,
      course: c,
      expires_at: apres(60),
      is_chain_bonus: false,
    });
  });

  it.each([
    ['échue', { expires_at: avant(1) }, {}],
    ['déjà close', { status: CourseOfferStatus.CANCELLED, expires_at: apres(60) }, {}],
    ['course confiée à Turbo', { expires_at: apres(60) }, { turbo_escalated_at: avant(10) }],
    ['course plus en recherche', { expires_at: apres(60) }, { statut: CourseStatut.ACCEPTED }],
  ])('%s : rien', async (_nom, surchargeOffre, surchargeCourse) => {
    const l = livreur();
    const c = course(surchargeCourse);
    const t = monter({
      livreurs: [l],
      courses: [c],
      offres: [offre({ course_id: c.id, deliverer_id: l.id, ...surchargeOffre })],
    });
    expect(await t.offreEnAttente.pourLivreur(l.id)).toBeNull();
  });

  it('connexion du socket : l’offre est renvoyée au livreur ; sans offre, rien', async () => {
    const l = livreur();
    const sansOffre = livreur();
    const c = course();
    const t = monter({
      livreurs: [l, sansOffre],
      courses: [c],
      offres: [offre({ course_id: c.id, deliverer_id: l.id, expires_at: apres(60) })],
    });

    await t.ecouteur.onLivreurConnecte({ delivererId: l.id });
    await t.ecouteur.onLivreurConnecte({ delivererId: sansOffre.id });

    expect(t.gateway.emitToDeliverer).toHaveBeenCalledTimes(1);
    expect(t.gateway.emitToDeliverer).toHaveBeenCalledWith(l.id, CourseChannels.COURSE_OFFER_NEW, {
      offer_id: c.id,
      course: c,
      expires_at: apres(60),
      is_chain_bonus: false,
    });
  });
});

describe('expiration d’une offre (CourseOfferService)', () => {
  it("prévient l'appli et le journal : course:offer:expired, motif EXPIREE", async () => {
    const prisma = {
      courseOfferAttempt: {
        findMany: jest.fn(async () => [
          {
            id: 'o1',
            course_id: 'c1',
            deliverer_id: 'l1',
            course: { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: null },
            deliverer: { pause_until: null, auto_pause_until: null },
          },
        ]),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      course: { update: jest.fn(async () => ({})) },
    };
    const courseEvent = { offerExpired: jest.fn(async () => undefined) };
    const queueService = { onOfferExpired: jest.fn(async () => ({ autoPaused: false })) };
    const service = new CourseOfferService(
      prisma as never,
      courseEvent as never,
      {} as never,
      {} as never,
      {} as never,
      queueService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'offerNextDeliverer').mockResolvedValue(undefined);

    await service.expirePendingOffers();

    expect(courseEvent.offerExpired).toHaveBeenCalledWith({
      course_id: 'c1',
      deliverer_id: 'l1',
      motif: 'EXPIREE',
      penalite: true,
    });
  });
});
