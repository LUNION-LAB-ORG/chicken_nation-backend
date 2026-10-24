/**
 * SAC OUBLIÉ PUIS RETOUR AU RESTAURANT (demandes des écrans, relecture du
 * 24/10). Les VRAIS services sur la base simulée (banc-planificateur.simulee-spec.ts).
 *
 * La caisse Sunmi remet commande par commande ; le livreur part avant la
 * dernière remise (« Sac oublié »), puis revient chercher le sac :
 *  - bouton « Livreur a récupéré » APRÈS le départ : la course relue part au
 *    livreur tout de suite (sa livraison démarre dans l'appli sans attendre
 *    la relecture de 15 s), « Tout est récupéré » quand plus rien n'attend ;
 *  - le livreur montre le code (écran « Sac au restaurant ») : la caisse le
 *    saisit, la commande d'origine restée prête lui est remise ;
 *  - une commande AJOUTÉE pas remise, elle, est détachée au départ : le code
 *    ne la remet jamais après coup (409 « Le livreur vient de partir »).
 *
 * Et `Course.motif_depart` : ce qui a posé `parti_at` (départ réel ou fenêtre
 * fermée d'office), lu par la caisse et le backoffice.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { CourseChannels } from '../enums/course-channels';
import { estDepartReel, MESSAGE_LIVREUR_PARTI, MESSAGE_RIEN_A_REMETTRE } from '../helpers/depart.rules';
import { apres, AU_COMPTOIR, avant, B, MAINTENANT, monter, prete, RESTAURANT } from './banc-planificateur.simulee-spec';
import { course, livraison, livreur, RESTO } from './base-dispatch.simulee-spec';

jest.setTimeout(30_000);

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Ce que `PATCH /orders/:id/status` émet après avoir passé la commande PICKED_UP (bouton de la caisse). */
const boutonCaisse = (o: Record<string, any>) => {
  o.status = OrderStatus.PICKED_UP;
  o.picked_up_at = new Date();
  return { order: { ...o, type: OrderType.DELIVERY } } as never;
};

/** La caisse saisit le code de retrait (caisse Sunmi : restaurant de son compte). */
const saisirCode = (t: ReturnType<typeof monter>, code: string) =>
  t.actions.validatePickupByCashier({ pickup_code: code, restaurant_id: RESTO } as never, undefined);

/** D1 au comptoir, sa course K (A puis B, même direction) au restaurant, rien de remis. */
function auRestaurant(protocole: number, reglages: Record<string, string> = {}) {
  const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: protocole });
  const a = prete();
  const b = prete({ address: B });
  const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(400), at_restaurant_at: avant(100) });
  const t = monter(
    {
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }), livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 })],
      livreurs: [d1],
    },
    { reglages },
  );
  jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);
  return { d1, a, b, k, t };
}

/** Comme `auRestaurant`, A remise au bouton, puis « Je pars » 30 s plus tard : B reste au comptoir. */
async function partiSansB() {
  const s = auRestaurant(3);
  await s.t.remiseCaisse.onStatutCommande(boutonCaisse(s.a));
  jest.setSystemTime(apres(30));
  await s.t.depart.jePars(s.k.id, s.d1.id);
  expect(s.k.parti_at).toEqual(apres(30));
  expect(s.t.push.notifySacOublie).toHaveBeenCalledTimes(1);
  s.t.emis.length = 0;
  return s;
}

const evenementsRetrait = (t: ReturnType<typeof monter>) =>
  t.emisSur(CourseChannels.COURSE_STATUT_CHANGED).filter((e: any) => e.reason === 'RETRAIT_COMPLEMENTAIRE');

describe('bouton « Livreur a récupéré » sur le sac oublié, après le départ', () => {
  it('la course relue part au livreur tout de suite, « Tout est récupéré », journal noté après le départ', async () => {
    const { a, b, d1, k, t } = await partiSansB();

    jest.setSystemTime(apres(600));
    await t.remiseCaisse.onStatutCommande(boutonCaisse(b));

    // La course reste partie, en livraison ; B est remise.
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(k.parti_at).toEqual(apres(30));
    expect(b.status).toBe(OrderStatus.PICKED_UP);
    const [evenement] = evenementsRetrait(t) as any[];
    expect(evenementsRetrait(t)).toHaveLength(1);
    expect(evenement.course.id).toBe(k.id);
    expect(evenement.course.deliveries.find((l: any) => l.order_id === b.id).order.status).toBe(OrderStatus.PICKED_UP);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d1.id, courseId: k.id, titre: 'Tout est récupéré', corps: 'Tu peux partir' }),
    );
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE').at(-1)).toMatchObject({
      source: 'caisse',
      order_id: b.id,
      details: expect.objectContaining({ commandes: [b.reference], apres_depart: true }),
    });
    // Sa livraison peut démarrer (l'appli le fait dès la course relue) : plus de 409.
    const lb = t.livraisonsDe(k.id).find((l) => l.order_id === b.id)!;
    const premiere = t.livraisonsDe(k.id).find((l) => l.order_id === a.id)!;
    premiere.statut = DeliveryStatut.DELIVERED;
    await t.actionsLivraison.startDelivery(lb.id, d1.id);
    expect(lb.statut).toBe(DeliveryStatut.IN_ROUTE);
  });

  it('avant le départ, un sac encore au comptoir : la course relue part au livreur (sac pris), sans « Tout est récupéré »', async () => {
    const { a, k, t } = auRestaurant(3);
    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(k.parti_at).toBeNull();
    t.emis.length = 0;

    // Second appui sur A (même sac) : rien de nouveau à prendre, mais la course relue repart.
    await t.depart.surRemiseParCaisse(k.id, { id: a.id, reference: a.reference });
    expect(evenementsRetrait(t)).toHaveLength(1);
    expect(t.push.notifyCommandeRemise).not.toHaveBeenCalled();
  });
});

describe('le livreur revient et montre le code (écran « Sac au restaurant »)', () => {
  it('la caisse saisit le code : la commande d’origine restée prête lui est remise', async () => {
    const { b, d1, k, t } = await partiSansB();

    jest.setSystemTime(apres(600));
    const rendue = await saisirCode(t, k.pickup_code);

    expect(rendue.id).toBe(k.id);
    expect(b.status).toBe(OrderStatus.PICKED_UP);
    expect(b.picked_up_at).toEqual(apres(600));
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(k.parti_at).toEqual(apres(30));
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE').at(-1)!.details).toMatchObject({ commandes: [b.reference], apres_depart: true });
    expect(evenementsRetrait(t)).toHaveLength(1);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id, titre: 'Tout est récupéré' }));

    // Plus rien à remettre : le code ne retrouve plus la course.
    await expect(saisirCode(t, k.pickup_code)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deux caisses au même instant : une seule remet, l’autre reçoit « déjà remises », le livreur est prévenu une fois', async () => {
    const { b, k, t } = await partiSansB();
    jest.setSystemTime(apres(600));
    const vue = await t.requetes.findByActivePickupCode(k.pickup_code, undefined, RESTO);

    await t.depart.remettreComplement(vue);
    await expect(t.depart.remettreComplement(vue)).rejects.toThrow(new ConflictException(MESSAGE_RIEN_A_REMETTRE));
    expect(b.status).toBe(OrderStatus.PICKED_UP);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledTimes(1);
  });

  it('restaurant en v1 : exactement comme avant, le code ne retrouve pas la course partie et le bouton n’annonce rien', async () => {
    const { a, b, k, t } = auRestaurant(3, { 'course.planificateur': 'v1' });
    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));
    expect(k.parti_at).toEqual(MAINTENANT);
    expect(k.motif_depart).toBe('REPLI_V1');

    jest.setSystemTime(apres(60));
    await expect(saisirCode(t, k.pickup_code)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.status).toBe(OrderStatus.READY);

    t.emis.length = 0;
    const journalAvant = t.base.journal.length;
    await t.remiseCaisse.onStatutCommande(boutonCaisse(b));
    expect(evenementsRetrait(t)).toHaveLength(0);
    expect(t.push.notifyCommandeRemise).not.toHaveBeenCalled();
    expect(t.base.journal.length).toBe(journalAvant);
  });
});

describe('commande AJOUTÉE après le retrait, pas remise : jamais remise par le code après le départ', () => {
  function avecAjout() {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 3 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60) });
    const c = prete({ address: B, ready_at: avant(10) });
    const k = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: d1.id, assigned_at: avant(600), at_restaurant_at: avant(400), picked_up_at: avant(60) });
    const t = monter({
      commandes: [a, c],
      courses: [k],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k.id, order_id: c.id, sequence_order: 2, ajoutee_at: avant(10), ajoutee_apres_retrait: true }),
      ],
      livreurs: [d1],
    });
    jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);
    return { d1, a, c, k, t };
  }

  it('la caisse avait la course à l’écran quand il est parti : 409 « Le livreur vient de partir », rien de remis', async () => {
    const { c, d1, k, t } = avecAjout();
    const vue = await t.requetes.findByActivePickupCode(k.pickup_code, undefined, RESTO);

    await t.depart.jePars(k.id, d1.id);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).not.toContain(c.id);

    await expect(t.depart.remettreComplement(vue)).rejects.toThrow(new ConflictException(MESSAGE_LIVREUR_PARTI));
    expect(c.status).toBe(OrderStatus.READY);
    expect(t.push.notifyCommandeRemise).not.toHaveBeenCalled();
    // Le code ne retrouve plus la course : C repart seule.
    await expect(saisirCode(t, k.pickup_code)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Course.motif_depart : ce qui a posé le départ', () => {
  it('« Je pars » : BOUTON, départ réel', async () => {
    const { k } = await partiSansB();
    expect(k.motif_depart).toBe('BOUTON');
    expect(estDepartReel(k.motif_depart)).toBe(true);
  });

  it('ancienne appli : fenêtre fermée à la validation, ANCIENNE_APPLI, pas un départ réel', async () => {
    const { k, t } = auRestaurant(2);
    await saisirCode(t, k.pickup_code);
    expect(k.parti_at).toEqual(MAINTENANT);
    expect(k.motif_depart).toBe('ANCIENNE_APPLI');
    expect(estDepartReel(k.motif_depart)).toBe(false);
  });

  it('position hors du rayon : POSITION ; fenêtre écoulée au passage : FENETRE_ECHUE', async () => {
    const s = auRestaurant(3);
    await saisirCode(s.t, s.k.pickup_code);
    jest.setSystemTime(apres(20));
    s.d1.last_location = { lat: RESTAURANT.lat, lng: RESTAURANT.lng + 400 / 110_800 };
    s.d1.last_location_at = new Date();
    await s.t.ecouteur.onPosition({
      delivererId: s.d1.id,
      lat: RESTAURANT.lat,
      lng: RESTAURANT.lng + 400 / 110_800,
      heading: null,
      speedKmh: null,
      accuracyM: 10,
      ts: new Date().toISOString(),
      restaurantId: RESTO,
    } as never);
    expect(s.k.motif_depart).toBe('POSITION');

    const s2 = auRestaurant(3);
    s2.d1.last_location = null;
    s2.d1.last_location_at = null;
    await saisirCode(s2.t, s2.k.pickup_code); // à +20 s
    jest.setSystemTime(apres(20 + 245));
    await s2.t.passer();
    expect(s2.k.motif_depart).toBe('FENETRE_ECHUE');
    expect(estDepartReel(s2.k.motif_depart)).toBe(true);
  });

  it('jamais réel sans motif (course partie avant la colonne) ni pour une fenêtre fermée d’office', () => {
    expect(estDepartReel(null)).toBe(false);
    expect(estDepartReel(undefined)).toBe(false);
    for (const m of ['REPLI_V1', 'AJOUT_COUPE', 'ANCIENNE_APPLI', 'SANS_LIVREUR', 'DEJA_PARTI', 'SANS_RETRAIT']) {
      expect(estDepartReel(m)).toBe(false);
    }
    for (const m of ['BOUTON', 'POSITION', 'LIVRAISON_DEMARREE', 'FENETRE_ECHUE']) {
      expect(estDepartReel(m)).toBe(true);
    }
  });
});
