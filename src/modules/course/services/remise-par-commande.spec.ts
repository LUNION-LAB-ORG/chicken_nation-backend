/**
 * REMISE COMMANDE PAR COMMANDE AU BOUTON DE LA CAISSE (seconde relecture du
 * 23/10) : la caisse Sunmi ne saisit pas de code ; la caissière touche
 * « Livreur a récupéré » commande par commande. Les VRAIS services sur la base
 * simulée (banc-planificateur.simulee-spec.ts).
 *
 *  - pas de « Sacs remis, tu peux partir » tant qu'un sac reste au comptoir
 *    (nouvelle appli) ; la dernière remise l'annonce (« Tout est récupéré ») ;
 *    l'ancienne appli garde l'annonce à la première remise, comme avant ;
 *  - départ réel (« Je pars », position, fenêtre écoulée) alors qu'une
 *    commande d'origine est encore au comptoir : journal, cloche du
 *    restaurant et du siège, et « Sac oublié » au livreur (relecture du
 *    24/10), au lieu du silence. Une commande ajoutée après le retrait, elle,
 *    est détachée et replanifiée sans alerte.
 */
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { course, livraison, livreur } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, B, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';

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

describe('remise commande par commande au bouton de la caisse', () => {
  function auRestaurant(protocole: number) {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: protocole });
    const a = prete();
    const b = prete({ address: B });
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(400), at_restaurant_at: avant(100) });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }), livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 })],
      livreurs: [d1],
    });
    jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);
    return { d1, a, b, k, t };
  }

  it('ancienne appli : la fenêtre est fermée d’office, « Sacs remis » part comme avant', async () => {
    const { d1, a, k, t } = auRestaurant(2);
    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));
    expect(k.parti_at).toEqual(MAINTENANT);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id }));
  });

  it('nouvelle appli : le livreur part avec un sac au comptoir (« Je pars ») : journal et cloche du restaurant et du siège', async () => {
    const { d1, a, b, k, t } = auRestaurant(3);
    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();

    jest.setSystemTime(apres(30));
    await t.depart.jePars(k.id, d1.id);

    expect(k.parti_at).toBeTruthy();
    expect(t.journalDe('DEPART_SANS_COMMANDE')).toEqual([
      expect.objectContaining({ course_id: k.id, motif: 'BOUTON', details: expect.objectContaining({ commandes: [b.reference] }) }),
    ]);
    expect(t.cloche.sendCommandePasRemiseBell).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: k.id, reference: k.reference, commandes: [b.reference] }),
    );
    // Le livreur le sait tout de suite : « Sac oublié », un sac au restaurant.
    expect(t.push.notifySacOublie).toHaveBeenCalledTimes(1);
    expect(t.push.notifySacOublie).toHaveBeenCalledWith({
      delivererId: d1.id,
      courseId: k.id,
      titre: 'Sac oublié',
      corps: '1 sac au restaurant',
      commandes: [b.reference],
    });
    // Rien ne la retire de la course (la caissière l'a peut-être donnée sans toucher le bouton).
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id, b.id]);
    expect(t.livraisonsDe(k.id).find((l) => l.order_id === b.id)!.statut).toBe(DeliveryStatut.PENDING);
  });

  it('fenêtre écoulée : la course attend le sac 2 min de plus au comptoir, puis partie au passage, la commande pas remise est signalée', async () => {
    const { a, b, k, t, d1 } = auRestaurant(3);
    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));
    jest.setSystemTime(apres(245));
    // Dernière position au comptoir, ancienne (appli en arrière-plan sans la permission « Toujours ») :
    // il attend son sac (seconde passe), rien ne part.
    d1.last_location_at = avant(16 * 60);
    await t.passer();
    expect(k.parti_at).toBeNull();
    expect(t.cloche.sendCommandePasRemiseBell).not.toHaveBeenCalled();

    jest.setSystemTime(apres(366));
    await t.passer();

    expect(k.parti_at).toBeTruthy();
    expect(t.journalDe('DEPART_SANS_COMMANDE')).toEqual([expect.objectContaining({ motif: 'FENETRE_ECHUE' })]);
    expect(t.cloche.sendCommandePasRemiseBell).toHaveBeenCalledWith(expect.objectContaining({ commandes: [b.reference] }));
    expect(t.push.notifySacOublie).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id, commandes: [b.reference] }));
  });

  it('commande ajoutée après le retrait, pas remise, au départ : détachée et replanifiée, jamais signalée', async () => {
    // Aucune position connue : rien ne dit qu'il attend au comptoir, la fenêtre échue le fait partir.
    const d1 = livreur({ ...AU_COMPTOIR, last_location: null, last_location_at: null, last_available_at: null, protocole_appli: 3 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(241) });
    const c = prete({ address: B, ready_at: avant(100) });
    const k = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: d1.id, assigned_at: avant(600), at_restaurant_at: avant(400), picked_up_at: avant(241) });
    const t = monter({
      commandes: [a, c],
      courses: [k],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k.id, order_id: c.id, sequence_order: 2, ajoutee_at: avant(100), ajoutee_apres_retrait: true }),
      ],
      livreurs: [d1],
    });

    await t.passer();

    expect(t.journalDe('COURSE_PARTIE')).toEqual([expect.objectContaining({ motif: 'FENETRE_ECHUE' })]);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id]);
    expect(t.journalDe('DEPART_SANS_COMMANDE')).toEqual([]);
    expect(t.cloche.sendCommandePasRemiseBell).not.toHaveBeenCalled();
    expect(t.push.notifySacOublie).not.toHaveBeenCalled();
  });

  it('tout remis puis départ : aucune cloche', async () => {
    const { a, b, d1, k, t } = auRestaurant(3);
    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));
    await t.remiseCaisse.onStatutCommande(boutonCaisse(b));
    await t.depart.jePars(k.id, d1.id);
    expect(t.journalDe('DEPART_SANS_COMMANDE')).toEqual([]);
    expect(t.cloche.sendCommandePasRemiseBell).not.toHaveBeenCalled();
    expect(t.push.notifySacOublie).not.toHaveBeenCalled();
  });
});
