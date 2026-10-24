/**
 * Pause, reprise, disponibilité, déconnexion et filet « hors service sans
 * signal », testés par les routes du livreur sur une base simulée, avec le
 * VRAI service de clôture des offres et le VRAI journal.
 *
 * Demande du 22/10 : un livreur en pause ne reçoit aucune course. L'ancienne
 * appli appelle `/available` à chaque ouverture de l'accueil en se croyant
 * disponible : c'est ce qui effaçait la pause.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut } from '@prisma/client';

import { AuthDelivererService } from 'src/modules/auth-deliverer/services/auth-deliverer.service';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import { DispatchEvenements } from 'src/modules/course/enums/dispatch-evenements';
import { DispatchJournalService } from 'src/modules/course/services/dispatch-journal.service';
import { OffresClotureService } from 'src/modules/course/services/offres-cloture.service';

import { DeliverersSelfController } from '../controllers/deliverers-self.controller';
import { DelivererChannels } from '../enums/deliverer-channels';
import { FIN_PAUSE_INDEFINIE } from '../helpers/disponibilite.rules';
import { DisponibiliteListener } from '../listeners/disponibilite.listener';
import { appliLivreurSimulee, busSimule, course, livreur, monterBase, offre } from './base-livreurs.simulee-spec';
import { DisponibiliteLivreurService } from './disponibilite-livreur.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);
const apres = (min: number) => new Date(MAINTENANT.getTime() + min * 60_000);

type Donnees = Parameters<typeof monterBase>[0];

function monter(
  donnees: Donnees,
  reglages: { horsServiceSansSignalMin?: number; appli?: Parameters<typeof appliLivreurSimulee>[1] } = {},
) {
  const base = monterBase(donnees);
  // Par défaut, appli active (socket ouvert) : le filet vise un téléphone oublié appli ouverte.
  const appli = appliLivreurSimulee(base.prisma, reglages.appli);
  const { bus, emis } = busSimule();
  const journal = new DispatchJournalService(base.prisma);
  const cloture = new OffresClotureService(base.prisma, bus as never, journal);
  const delivererEvent = { queueChanged: jest.fn() };
  const push = { notifyRappelPause: jest.fn(), notifyMisEnPause: jest.fn() };
  const settings = {
    load: jest.fn(async () => ({ horsServiceSansSignalMin: reglages.horsServiceSansSignalMin ?? 20 })),
  };
  const disponibilite = new DisponibiliteLivreurService(
    base.prisma,
    delivererEvent as never,
    push as never,
    settings as never,
    cloture,
    journal,
    appli.service,
  );
  const controleur = new DeliverersSelfController(
    {} as never,
    {} as never,
    {} as never,
    disponibilite,
  );
  const types = () => base.journal.map((l) => l.type);
  return { ...base, emis, bus, push, delivererEvent, disponibilite, controleur, cloture, types, appli };
}

/** Le livreur connecté, tel que le décorateur `CurrentDeliverer` le passe. */
const connecte = (l: Record<string, any>) => l as never;

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('POST /deliverers/me/pause', () => {
  it("clôt l'offre en attente sans pénalité, prévient l'appli et relance la recherche", async () => {
    const l = livreur();
    const c = course({ offer_expires_at: apres(1) });
    const o = offre({ course_id: c.id, deliverer_id: l.id, expires_at: apres(1) });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    const reponse = await t.controleur.pause(connecte(l), {});

    expect(reponse).toEqual({
      id: l.id,
      pause_until: FIN_PAUSE_INDEFINIE,
      last_available_at: null,
      restaurant_id: l.restaurant_id,
    });
    // Offre close, sans pénalité : ni refus compté sur la course, ni sanction du livreur.
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(o.responded_at).toEqual(MAINTENANT);
    expect(c.refusal_count).toBe(0);
    expect(c.offer_expires_at).toBeNull();
    expect(l.queue_penalty_positions).toBe(0);
    expect(l.auto_pause_until).toBeNull();
    // L'appli ferme l'offre, la recherche repart vers un autre livreur.
    expect(t.emis).toEqual([
      {
        canal: CourseChannels.COURSE_OFFER_EXPIRED,
        charge: { course_id: c.id, deliverer_id: l.id, motif: 'LIVREUR_EN_PAUSE' },
      },
      { canal: DispatchEvenements.RECHERCHE_A_RELANCER, charge: { course_id: c.id } },
    ]);
    expect(t.types()).toEqual(['OFFRE_CLOSE', 'PAUSE']);
    expect(t.journal[0]).toMatchObject({
      motif: 'LIVREUR_EN_PAUSE',
      source: 'appli',
      course_id: c.id,
      deliverer_id: l.id,
      offre_id: o.id,
      restaurant_id: c.restaurant_id,
    });
    expect(t.delivererEvent.queueChanged).toHaveBeenCalledWith(l.id, l.restaurant_id);
  });

  it('avec une durée : pause jusqu’à maintenant + durée', async () => {
    const l = livreur();
    const t = monter({ livreurs: [l] });
    await t.controleur.pause(connecte(l), { durationMinutes: 15 });
    expect(l.pause_until).toEqual(apres(15));
    expect(l.last_available_at).toBeNull();
    expect(t.journal[0]).toMatchObject({ type: 'PAUSE', details: { jusqua: apres(15).toISOString() } });
  });

  it('course déjà confiée à Turbo : offre close, mais aucune recherche interne relancée', async () => {
    const l = livreur();
    const c = course({ turbo_escalated_at: avant(1) });
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    await t.controleur.pause(connecte(l), {});

    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.emis.map((e) => e.canal)).toEqual([CourseChannels.COURSE_OFFER_EXPIRED]);
  });

  it("ne touche ni aux offres des autres livreurs ni aux offres déjà traitées", async () => {
    const l = livreur();
    const autre = livreur();
    const c1 = course();
    const c2 = course();
    const sienneTraitee = offre({ course_id: c1.id, deliverer_id: l.id, status: CourseOfferStatus.REFUSED });
    const cellesDeLAutre = offre({ course_id: c2.id, deliverer_id: autre.id });
    const t = monter({ livreurs: [l, autre], courses: [c1, c2], offres: [sienneTraitee, cellesDeLAutre] });

    await t.controleur.pause(connecte(l), {});

    expect(sienneTraitee.status).toBe(CourseOfferStatus.REFUSED);
    expect(cellesDeLAutre.status).toBe(CourseOfferStatus.PENDING);
    expect(t.emis).toEqual([]);
  });

  it('une clôture qui échoue ne défait pas la pause', async () => {
    const l = livreur();
    const t = monter({ livreurs: [l] });
    jest.spyOn(t.cloture, 'clorePourLivreur').mockRejectedValue(new Error('base indisponible'));

    await expect(t.controleur.pause(connecte(l), {})).resolves.toMatchObject({ pause_until: FIN_PAUSE_INDEFINIE });
    expect(l.pause_until).toEqual(FIN_PAUSE_INDEFINIE);
  });
});

describe('POST /deliverers/me/available', () => {
  it('en pause : AUCUN changement, 200 en_pause, un rappel au plus toutes les 30 minutes', async () => {
    const l = livreur({ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null });
    const t = monter({ livreurs: [l] });

    const reponse = await t.controleur.markAvailable(connecte(l));

    expect(reponse).toMatchObject({
      en_pause: true,
      pause_until: FIN_PAUSE_INDEFINIE,
      auto_pause_until: null,
      last_available_at: null,
    });
    expect(l.pause_until).toEqual(FIN_PAUSE_INDEFINIE);
    expect(l.last_available_at).toBeNull();
    expect(t.push.notifyRappelPause).toHaveBeenCalledTimes(1);
    expect(t.journal[0]).toMatchObject({
      type: 'DISPONIBLE_REFUSE_EN_PAUSE',
      motif: 'EN_PAUSE',
      deliverer_id: l.id,
      details: { rappel_envoye: true },
    });

    // Réouverture 10 min plus tard : toujours en pause, pas de second rappel.
    jest.setSystemTime(apres(10));
    await t.controleur.markAvailable(connecte(l));
    expect(t.push.notifyRappelPause).toHaveBeenCalledTimes(1);
    expect(t.journal[1]).toMatchObject({ details: { rappel_envoye: false } });

    // 31 min après le premier : nouveau rappel.
    jest.setSystemTime(apres(31));
    await t.controleur.markAvailable(connecte(l));
    expect(t.push.notifyRappelPause).toHaveBeenCalledTimes(2);
    expect(t.types()).toEqual([
      'DISPONIBLE_REFUSE_EN_PAUSE',
      'DISPONIBLE_REFUSE_EN_PAUSE',
      'DISPONIBLE_REFUSE_EN_PAUSE',
    ]);
    expect(t.delivererEvent.queueChanged).not.toHaveBeenCalled();
  });

  it('en pause automatique : rien ne change non plus (la sanction tient)', async () => {
    const l = livreur({ auto_pause_until: apres(20), last_available_at: null });
    const t = monter({ livreurs: [l] });

    const reponse = await t.controleur.markAvailable(connecte(l));

    expect(reponse).toMatchObject({ en_pause: true, auto_pause_until: apres(20) });
    expect(l.auto_pause_until).toEqual(apres(20));
    expect(l.last_available_at).toBeNull();
    expect(t.journal[0]).toMatchObject({ type: 'DISPONIBLE_REFUSE_EN_PAUSE', motif: 'PAUSE_AUTO' });
  });

  it('hors pause et hors service : entre dans la file maintenant', async () => {
    const l = livreur({ last_available_at: null });
    const t = monter({ livreurs: [l] });

    const reponse = await t.controleur.markAvailable(connecte(l));

    expect(reponse).toMatchObject({ en_pause: false, last_available_at: MAINTENANT });
    expect(l.last_available_at).toEqual(MAINTENANT);
    expect(t.types()).toEqual(['DISPONIBLE']);
    expect(t.delivererEvent.queueChanged).toHaveBeenCalledWith(l.id, l.restaurant_id);
  });

  it('déjà dans la file : garde sa place (rouvrir l’appli ne renvoie plus en fin de file)', async () => {
    const place = avant(45);
    const l = livreur({ last_available_at: place });
    const t = monter({ livreurs: [l] });

    const reponse = await t.controleur.markAvailable(connecte(l));

    expect(reponse).toMatchObject({ en_pause: false, last_available_at: place });
    expect(l.last_available_at).toEqual(place);
    expect(t.types()).toEqual([]);
    expect(t.delivererEvent.queueChanged).not.toHaveBeenCalled();
  });

  it('pause échue : entre dans la file', async () => {
    const l = livreur({ pause_until: avant(1), auto_pause_until: avant(2), last_available_at: null });
    const t = monter({ livreurs: [l] });
    await t.controleur.markAvailable(connecte(l));
    expect(l.last_available_at).toEqual(MAINTENANT);
  });
});

describe('POST /deliverers/me/resume', () => {
  it("pause automatique active : 409 « Pause automatique jusqu'à 14 h 32. », rien ne change", async () => {
    const finAuto = new Date('2026-10-22T14:32:00.000Z');
    const l = livreur({ pause_until: FIN_PAUSE_INDEFINIE, auto_pause_until: finAuto, last_available_at: null });
    const t = monter({ livreurs: [l] });

    const erreur = await t.controleur.resume(connecte(l)).catch((e) => e);

    expect(erreur).toBeInstanceOf(ConflictException);
    expect(erreur.getStatus()).toBe(409);
    expect(erreur.message).toBe("Pause automatique jusqu'à 14 h 32.");
    expect(l.pause_until).toEqual(FIN_PAUSE_INDEFINIE);
    expect(l.auto_pause_until).toEqual(finAuto);
    expect(t.types()).toEqual(['REPRISE_REFUSEE_PAUSE_AUTO']);
  });

  it('lève la pause manuelle seulement, sans remettre dans la file', async () => {
    const l = livreur({ pause_until: FIN_PAUSE_INDEFINIE, auto_pause_until: avant(5), last_available_at: null });
    const t = monter({ livreurs: [l] });

    const reponse = await t.controleur.resume(connecte(l));

    expect(reponse).toEqual({
      id: l.id,
      pause_until: null,
      auto_pause_until: avant(5),
      restaurant_id: l.restaurant_id,
    });
    expect(l.last_available_at).toBeNull();
    expect(t.journal[0]).toMatchObject({ type: 'REPRISE', details: { etait_en_pause: true } });
  });

  it('Reprendre de l’ancienne appli (/resume puis /available) : de nouveau en service', async () => {
    const l = livreur({ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null });
    const t = monter({ livreurs: [l] });
    await t.controleur.resume(connecte(l));
    await t.controleur.markAvailable(connecte(l));
    expect(l.pause_until).toBeNull();
    expect(l.last_available_at).toEqual(MAINTENANT);
    expect(t.types()).toEqual(['REPRISE', 'DISPONIBLE']);
  });
});

describe('POST /deliverers/me/unavailable (écran de blocage de la nouvelle appli, 24/10)', () => {
  it("sort de la file et clôt l'offre en attente sans pénalité, la recherche repart", async () => {
    const l = livreur();
    const c = course({ offer_expires_at: apres(1) });
    const o = offre({ course_id: c.id, deliverer_id: l.id, expires_at: apres(1) });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    const reponse = await t.controleur.markUnavailable(connecte(l));

    expect(reponse).toEqual({ id: l.id, last_available_at: null });
    expect(l.last_available_at).toBeNull();
    // Ni pause : il revient par `/available` dès que l'appli est débloquée.
    expect(l.pause_until).toBeNull();
    // Offre close, sans pénalité : ni refus compté sur la course, ni sanction du livreur.
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(o.responded_at).toEqual(MAINTENANT);
    expect(c.refusal_count).toBe(0);
    expect(l.queue_penalty_positions).toBe(0);
    expect(t.emis).toEqual([
      {
        canal: CourseChannels.COURSE_OFFER_EXPIRED,
        charge: { course_id: c.id, deliverer_id: l.id, motif: 'LIVREUR_SORTI_DE_LA_FILE' },
      },
      { canal: DispatchEvenements.RECHERCHE_A_RELANCER, charge: { course_id: c.id } },
    ]);
    expect(t.journal[0]).toMatchObject({
      type: 'OFFRE_CLOSE',
      motif: 'LIVREUR_SORTI_DE_LA_FILE',
      source: 'appli',
      course_id: c.id,
      deliverer_id: l.id,
    });
  });

  it("sans offre en attente : sorti de la file, rien d'autre ; une clôture qui échoue ne l'empêche pas", async () => {
    const l = livreur();
    const t = monter({ livreurs: [l] });
    await t.controleur.markUnavailable(connecte(l));
    expect(l.last_available_at).toBeNull();
    expect(t.emis).toEqual([]);

    l.last_available_at = avant(1);
    jest.spyOn(t.cloture, 'clorePourLivreur').mockRejectedValue(new Error('base indisponible'));
    await expect(t.controleur.markUnavailable(connecte(l))).resolves.toEqual({ id: l.id, last_available_at: null });
    expect(l.last_available_at).toBeNull();
  });
});

describe('POST /auth/deliverer/logout', () => {
  it('hors service, pause « jusqu’à Reprendre », jeton de notification effacé, offres closes', async () => {
    const l = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });
    const ecouteur = new DisponibiliteListener(t.disponibilite);

    await ecouteur.onDeconnexion({ delivererId: l.id });

    expect(l.last_available_at).toBeNull();
    expect(l.pause_until).toEqual(FIN_PAUSE_INDEFINIE);
    expect(l.expo_push_token).toBeNull();
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.emis[0]).toEqual({
      canal: CourseChannels.COURSE_OFFER_EXPIRED,
      charge: { course_id: c.id, deliverer_id: l.id, motif: 'LIVREUR_DECONNECTE' },
    });
    expect(t.types()).toEqual(['OFFRE_CLOSE', 'DECONNEXION']);
  });

  it('le service d’authentification révoque la session puis attend la mise hors service', async () => {
    const l = livreur();
    const t = monter({ livreurs: [l] });
    const auth = new AuthDelivererService(
      t.prisma,
      {} as never,
      {} as never,
      {} as never,
      t.bus as never,
      {} as never,
      {} as never,
    );

    await expect(auth.logout(l.id)).resolves.toEqual({ message: 'Déconnexion réussie' });
    expect(l.refresh_token).toBeNull();
    expect(t.bus.emitAsync).toHaveBeenCalledWith(DelivererChannels.DELIVERER_LOGGED_OUT, {
      delivererId: l.id,
    });

    // Un échec de la mise hors service n'empêche pas la déconnexion.
    t.bus.emitAsync.mockRejectedValueOnce(new BadRequestException('panne'));
    await expect(auth.logout(l.id)).resolves.toEqual({ message: 'Déconnexion réussie' });
  });
});

describe('filet : offre ignorée sans aucun signal', () => {
  it('sans signal depuis 25 min : hors service, pause, notification, offres closes, journal', async () => {
    const l = livreur({ dernier_signal_at: avant(25) });
    const c = course();
    const autre = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [autre] });

    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(true);

    expect(l.last_available_at).toBeNull();
    expect(l.pause_until).toEqual(FIN_PAUSE_INDEFINIE);
    expect(autre.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.push.notifyMisEnPause).toHaveBeenCalledWith({ delivererId: l.id });
    expect(t.types()).toEqual(['OFFRE_CLOSE', 'HORS_SERVICE_SANS_SIGNAL']);
    expect(t.journal[1]).toMatchObject({
      source: 'serveur',
      details: { dernier_signal: avant(25).toISOString(), seuil_min: 20 },
    });
    // Second passage (autre serveur, autre offre) : déjà fait, pas de second message.
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);
    expect(t.push.notifyMisEnPause).toHaveBeenCalledTimes(1);
  });

  it('aucun signal connu : hors service', async () => {
    const l = livreur({ dernier_signal_at: null });
    const t = monter({ livreurs: [l] });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(true);
  });

  it('signal jamais noté (juste après le déploiement) mais position il y a 5 min : rien', async () => {
    const l = livreur({ dernier_signal_at: null, last_location_at: avant(5) });
    const t = monter({ livreurs: [l] });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);
    expect(l.last_available_at).not.toBeNull();
    expect(l.pause_until).toBeNull();
    expect(t.push.notifyMisEnPause).not.toHaveBeenCalled();
  });

  it('signal jamais noté et dernière position il y a 30 min : hors service', async () => {
    const l = livreur({ dernier_signal_at: null, last_location_at: avant(30) });
    const t = monter({ livreurs: [l] });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(true);
  });

  it('signal ancien : une position récente notée avant le champ ne compte plus', async () => {
    // dernier_signal_at est tenu à jour par chaque position depuis le 22/10 :
    // s'il est ancien, c'est lui qui fait foi.
    const l = livreur({ dernier_signal_at: avant(25), last_location_at: avant(25) });
    const t = monter({ livreurs: [l] });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(true);
  });

  it('signal il y a 5 min : rien (il a simplement laissé passer l’offre)', async () => {
    const l = livreur({ dernier_signal_at: avant(5) });
    const t = monter({ livreurs: [l] });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);
    expect(l.last_available_at).not.toBeNull();
    expect(t.journal).toEqual([]);
  });

  it('réglage à 0 : filet coupé', async () => {
    const l = livreur({ dernier_signal_at: avant(600) });
    const t = monter({ livreurs: [l] }, { horsServiceSansSignalMin: 0 });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);
    expect(l.pause_until).toBeNull();
  });

  it('déjà en pause : rien', async () => {
    const l = livreur({ dernier_signal_at: avant(600), pause_until: apres(10) });
    const t = monter({ livreurs: [l] });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);
    expect(l.pause_until).toEqual(apres(10));
    expect(t.push.notifyMisEnPause).not.toHaveBeenCalled();
  });

  it('appli simplement FERMÉE (24/10) : jamais hors service, ni pause, ni message, ni journal', async () => {
    const l = livreur({ dernier_signal_at: avant(25) });
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] }, { appli: { seuilS: 180, connectes: [] } });

    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);

    expect(l.last_available_at).not.toBeNull();
    expect(l.pause_until).toBeNull();
    expect(o.status).toBe(CourseOfferStatus.PENDING);
    expect(t.push.notifyMisEnPause).not.toHaveBeenCalled();
    expect(t.journal).toEqual([]);
  });

  it('présence inconnue et signe de vie vieux : appli réputée fermée, le filet l’épargne aussi', async () => {
    const l = livreur({ dernier_signal_at: avant(25) });
    const t = monter({ livreurs: [l] }, { appli: { seuilS: 180, connectes: null } });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(false);
    expect(l.pause_until).toBeNull();
  });

  it('règle de l’appli coupée (réglage à 0) : le filet joue comme avant', async () => {
    const l = livreur({ dernier_signal_at: avant(25) });
    const t = monter({ livreurs: [l] }, { appli: { seuilS: 0, connectes: [] } });
    expect(await t.disponibilite.mettreHorsServiceSiSansSignal(l.id)).toBe(true);
    expect(l.pause_until).toEqual(FIN_PAUSE_INDEFINIE);
  });
});

describe('clôture des offres', () => {
  it('deux clôtures simultanées (deux serveurs) : une seule compte', async () => {
    const l = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    const [a, b] = await Promise.all([
      t.cloture.clorePourLivreur(l.id, 'LIVREUR_EN_PAUSE'),
      t.cloture.clorePourCourse(c.id, 'COURSE_FUSIONNEE'),
    ]);

    expect(a.length + b.length).toBe(1);
    expect(t.emis.filter((e) => e.canal === CourseChannels.COURSE_OFFER_EXPIRED)).toHaveLength(1);
    expect(t.types()).toEqual(['OFFRE_CLOSE']);
  });

  it('course qui ne cherche plus de livreur : close sans relance', async () => {
    const l = livreur();
    const c = course({ statut: CourseStatut.CANCELLED });
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    const closes = await t.cloture.clorePourCourse(c.id, 'COURSE_ANNULEE');

    expect(closes).toEqual([
      { offre_id: o.id, course_id: c.id, deliverer_id: l.id, recherche_relancee: false },
    ]);
    expect(t.emis.map((e) => e.canal)).toEqual([CourseChannels.COURSE_OFFER_EXPIRED]);
  });

  it('relance refusée par l’appelant : close sans relance', async () => {
    const l = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });

    const closes = await t.cloture.cloreOffre(o.id, 'LIVREUR_INDISPONIBLE', {
      relancerRecherche: false,
    });

    expect(closes[0].recherche_relancee).toBe(false);
    expect(t.emis.map((e) => e.canal)).toEqual([CourseChannels.COURSE_OFFER_EXPIRED]);
  });

  it("l'échéance d'une offre plus récente sur la course n'est pas effacée", async () => {
    const l = livreur();
    const c = course({ offer_expires_at: apres(2) });
    const o = offre({ course_id: c.id, deliverer_id: l.id, expires_at: apres(1) });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });
    await t.cloture.cloreOffre(o.id, 'LIVREUR_INDISPONIBLE');
    expect(c.offer_expires_at).toEqual(apres(2));
  });

  it('le journal qui échoue ne fait pas échouer la clôture', async () => {
    const l = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: l.id });
    const t = monter({ livreurs: [l], courses: [c], offres: [o] });
    t.prisma.dispatchEvenement.create.mockRejectedValue(new Error('table absente'));

    await expect(t.cloture.cloreOffre(o.id, 'COURSE_CONFIEE_A_TURBO')).resolves.toHaveLength(1);
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
  });
});
