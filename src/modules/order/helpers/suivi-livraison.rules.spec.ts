import { CommandeLivraisonLue, CourseLivraisonLue, suiviLivraison } from './suivi-livraison.rules';

/** « 12:05 » le 24/10 (heure d'Abidjan = UTC). */
const t = (hhmm: string, ss = '00') => `2026-10-24T${hhmm}:${ss}.000Z`;
const d = (hhmm: string, ss = '00') => new Date(t(hhmm, ss));

const KOFFI = {
  id: 'liv-koffi',
  first_name: 'Koffi',
  last_name: 'Kouassi',
  phone: '+2250701020304',
  last_location: null,
  last_location_at: null,
};

function course(champs: Partial<CourseLivraisonLue> = {}): CourseLivraisonLue {
  return {
    id: 'crs-1',
    reference: 'CRS-261024-00001',
    pickup_code: '614',
    statut: 'COMPLETED',
    assigned_at: null,
    at_restaurant_at: null,
    picked_up_at: null,
    parti_at: null,
    motif_depart: null,
    estimated_duration_min: null,
    retenue_jusqua: null,
    deliverer: null,
    offer_attempts: [],
    deliveries: [{ id: 'liv-a', statut: 'PENDING', sequence_order: 1, order: { status: 'READY' } }],
    ...champs,
  };
}

function commande(
  champs: Partial<CommandeLivraisonLue> = {},
  livraison: Partial<NonNullable<CommandeLivraisonLue['delivery']>> | null = {},
): CommandeLivraisonLue {
  return {
    type: 'DELIVERY',
    status: 'READY',
    delivery_service: 'CHICKEN_NATION',
    ready_at: d('12:00'),
    picked_up_at: null,
    collected_at: null,
    restaurant: { latitude: 5.286, longitude: -3.9737 },
    delivery:
      livraison === null
        ? null
        : {
            id: 'liv-a',
            statut: 'PENDING',
            arrived_at: null,
            delivered_at: null,
            course: course(),
            ...livraison,
          },
    ...champs,
  };
}

const MAINTENANT = d('12:20');
const ctx = { maintenant: MAINTENANT, fenetreMaxS: 240, departRayonM: 150 };

describe('suivi de livraison : course interne terminée', () => {
  it('une commande : livreur, toutes les étapes avec leur heure, durées ; départ confondu avec la récupération omis', () => {
    const r = suiviLivraison(
      commande(
        { status: 'COMPLETED', picked_up_at: d('12:11'), collected_at: d('12:27') },
        {
          statut: 'DELIVERED',
          arrived_at: d('12:25'),
          delivered_at: d('12:27'),
          course: course({
            statut: 'COMPLETED',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:11'),
            // Parti 20 s après la récupération : rien de plus à dire.
            parti_at: d('12:11', '20'),
            motif_depart: 'POSITION',
            deliverer: KOFFI,
            deliveries: [
              {
                id: 'liv-a',
                statut: 'DELIVERED',
                sequence_order: 1,
                delivered_at: d('12:27'),
                order: { reference: 'ORD-261024-00001', status: 'COMPLETED' },
              },
            ],
          }),
        },
      ),
      { ...ctx, maintenant: d('12:40') },
    );

    expect(r).toEqual({
      service: 'CHICKEN_NATION',
      course: {
        id: 'crs-1',
        reference: 'CRS-261024-00001',
        code_retrait: '614',
        nombre_commandes: 1,
        rang_arret: 1,
        statut: 'COMPLETED',
        fin_prevue: null,
        en_retard: false,
        retard_min: null,
      },
      livreur: { id: 'liv-koffi', nom: 'Koffi Kouassi', telephone: '+2250701020304', etat: 'livree' },
      tournee: [{ reference: 'ORD-261024-00001', rang: 1, etat: 'livree', heure: t('12:27'), cette_commande: true, reportee: false }],
      livraison: { reportee_a: null },
      echec: null,
      etapes: [
        { cle: 'acceptee', heure: t('12:02'), prevue: null },
        { cle: 'arrivee_restaurant', heure: t('12:08'), prevue: null },
        { cle: 'recuperee', heure: t('12:11'), prevue: null },
        { cle: 'arrivee_client', heure: t('12:25'), prevue: null },
        { cle: 'livree', heure: t('12:27'), prevue: null },
      ],
      durees: {
        vers_restaurant_s: 6 * 60,
        attente_comptoir_s: 3 * 60,
        vers_client_s: 14 * 60,
        pret_a_livre_s: 27 * 60,
      },
    });
  });

  it('arrêt 2 sur 3 : départ distinct de la récupération donné à part, durée vers le client comptée du départ', () => {
    const r = suiviLivraison(
      commande(
        { status: 'COLLECTED', picked_up_at: d('12:11'), collected_at: d('12:33') },
        {
          id: 'liv-b',
          statut: 'DELIVERED',
          arrived_at: d('12:31'),
          delivered_at: d('12:33'),
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:11'),
            parti_at: d('12:15'),
            motif_depart: 'FENETRE_ECHUE',
            deliverer: KOFFI,
            deliveries: [
              { id: 'liv-a', statut: 'DELIVERED', sequence_order: 1, order: { status: 'COMPLETED' } },
              // Détachée : ne compte pas.
              { id: 'liv-x', statut: 'CANCELLED', sequence_order: 2, order: { status: 'READY' } },
              { id: 'liv-b', statut: 'DELIVERED', sequence_order: 3, order: { status: 'COLLECTED' } },
              { id: 'liv-c', statut: 'IN_ROUTE', sequence_order: 4, order: { status: 'PICKED_UP' } },
            ],
          }),
        },
      ),
      { ...ctx, maintenant: d('12:40') },
    );

    expect(r.course).toMatchObject({ nombre_commandes: 3, rang_arret: 2 });
    expect(r.livreur?.etat).toBe('livree');
    expect(r.etapes.map((e) => [e.cle, e.heure])).toEqual([
      ['acceptee', t('12:02')],
      ['arrivee_restaurant', t('12:08')],
      ['recuperee', t('12:11')],
      ['depart', t('12:15')],
      ['arrivee_client', t('12:31')],
      ['livree', t('12:33')],
    ]);
    expect(r.durees).toEqual({
      vers_restaurant_s: 6 * 60,
      attente_comptoir_s: 3 * 60,
      vers_client_s: 16 * 60,
      pret_a_livre_s: 33 * 60,
    });
  });

  it("fenêtre fermée d'office (ancienne appli) : pas de départ à part, même noté plus tard", () => {
    const r = suiviLivraison(
      commande(
        { status: 'PICKED_UP', picked_up_at: d('12:11') },
        {
          statut: 'IN_ROUTE',
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:11'),
            parti_at: d('12:14'),
            motif_depart: 'AJOUT_COUPE',
            deliverer: KOFFI,
          }),
        },
      ),
      ctx,
    );
    expect(r.etapes.map((e) => e.cle)).toEqual(['acceptee', 'arrivee_restaurant', 'recuperee', 'arrivee_client', 'livree']);
    expect(r.livreur?.etat).toBe('vers_client');
  });
});

describe('suivi de livraison : course en cours', () => {
  it('partie, dernier arrêt : arrivée chez le client prévue (départ + durée de la tournée), étapes à venir sans heure', () => {
    const r = suiviLivraison(
      commande(
        { status: 'PICKED_UP', picked_up_at: d('12:11') },
        {
          statut: 'IN_ROUTE',
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:11'),
            parti_at: d('12:13'),
            motif_depart: 'BOUTON',
            estimated_duration_min: 18,
            deliverer: KOFFI,
            deliveries: [{ id: 'liv-a', statut: 'IN_ROUTE', sequence_order: 1, order: { status: 'PICKED_UP' } }],
          }),
        },
      ),
      ctx,
    );
    expect(r.livreur?.etat).toBe('vers_client');
    expect(r.etapes).toEqual([
      { cle: 'acceptee', heure: t('12:02'), prevue: null },
      { cle: 'arrivee_restaurant', heure: t('12:08'), prevue: null },
      { cle: 'recuperee', heure: t('12:11'), prevue: null },
      { cle: 'depart', heure: t('12:13'), prevue: null },
      { cle: 'arrivee_client', heure: null, prevue: t('12:31') },
      { cle: 'livree', heure: null, prevue: null },
    ]);
    expect(r.durees).toEqual({ vers_restaurant_s: 360, attente_comptoir_s: 180, vers_client_s: null, pret_a_livre_s: null });
  });

  it("arrêt intermédiaire d'une course partie : aucune heure prévue inventée", () => {
    const r = suiviLivraison(
      commande(
        { status: 'PICKED_UP', picked_up_at: d('12:11') },
        {
          statut: 'PENDING',
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:11'),
            parti_at: d('12:13'),
            motif_depart: 'POSITION',
            estimated_duration_min: 30,
            deliverer: KOFFI,
            deliveries: [
              { id: 'liv-a', statut: 'PENDING', sequence_order: 1, order: { status: 'PICKED_UP' } },
              { id: 'liv-b', statut: 'PENDING', sequence_order: 2, order: { status: 'PICKED_UP' } },
            ],
          }),
        },
      ),
      ctx,
    );
    expect(r.course).toMatchObject({ nombre_commandes: 2, rang_arret: 1 });
    expect(r.etapes.filter((e) => !e.heure).every((e) => e.prevue === null)).toBe(true);
  });

  it('récupérée, livreur encore au comptoir : départ prévu à la fin de la fenêtre d’ajout (écran Opérations)', () => {
    const r = suiviLivraison(
      commande(
        { status: 'PICKED_UP', picked_up_at: d('12:18') },
        {
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:18'),
            deliverer: KOFFI,
            deliveries: [{ id: 'liv-a', statut: 'PENDING', sequence_order: 1, order: { status: 'PICKED_UP' } }],
          }),
        },
      ),
      ctx,
    );
    expect(r.livreur?.etat).toBe('au_comptoir');
    expect(r.etapes.map((e) => [e.cle, e.heure, e.prevue])).toEqual([
      ['acceptee', t('12:02'), null],
      ['arrivee_restaurant', t('12:08'), null],
      ['recuperee', t('12:18'), null],
      ['depart', null, t('12:22')],
      ['arrivee_client', null, null],
      ['livree', null, null],
    ]);
  });

  it('récupérée pendant une retenue levée depuis : départ prévu à la fin de la fenêtre comptée depuis la levée (25/10)', () => {
    const r = suiviLivraison(
      commande(
        { status: 'PICKED_UP', picked_up_at: d('12:18') },
        {
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:18'),
            retenue_jusqua: d('12:19', '30'),
            deliverer: KOFFI,
            deliveries: [{ id: 'liv-a', statut: 'PENDING', sequence_order: 1, order: { status: 'PICKED_UP' } }],
          }),
        },
      ),
      ctx,
    );
    expect(r.etapes.find((e) => e.cle === 'depart')?.prevue).toBe(t('12:23', '30'));
  });

  it('retenue au comptoir : départ prévu à la fin de la retenue, récupération à venir', () => {
    const r = suiviLivraison(
      commande(
        {},
        {
          course: course({
            statut: 'AT_RESTAURANT',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            retenue_jusqua: d('12:41'),
            deliverer: KOFFI,
          }),
        },
      ),
      ctx,
    );
    expect(r.livreur?.etat).toBe('au_comptoir');
    expect(r.etapes.map((e) => [e.cle, e.heure, e.prevue])).toEqual([
      ['acceptee', t('12:02'), null],
      ['arrivee_restaurant', t('12:08'), null],
      ['recuperee', null, null],
      ['depart', null, t('12:41')],
      ['arrivee_client', null, null],
      ['livree', null, null],
    ]);
  });

  it("commande ajoutée après le retrait, pas encore remise : au comptoir, récupération à venir (pas l'heure du premier retrait)", () => {
    const r = suiviLivraison(
      commande(
        { status: 'READY' },
        {
          id: 'liv-b',
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:02'),
            at_restaurant_at: d('12:08'),
            picked_up_at: d('12:11'),
            deliverer: KOFFI,
            deliveries: [
              { id: 'liv-a', statut: 'PENDING', sequence_order: 1, order: { status: 'PICKED_UP' } },
              { id: 'liv-b', statut: 'PENDING', sequence_order: 2, order: { status: 'READY' } },
            ],
          }),
        },
      ),
      { ...ctx, maintenant: d('12:13') },
    );
    expect(r.livreur?.etat).toBe('au_comptoir');
    expect(r.etapes.find((e) => e.cle === 'recuperee')).toEqual({ cle: 'recuperee', heure: null, prevue: null });
    expect(r.course).toMatchObject({ nombre_commandes: 2, rang_arret: 2 });
  });

  it('en route vers le restaurant : seule l’acceptation a une heure', () => {
    const r = suiviLivraison(
      commande({}, { course: course({ statut: 'ACCEPTED', assigned_at: d('12:15'), deliverer: KOFFI }) }),
      ctx,
    );
    expect(r.livreur).toEqual({ id: 'liv-koffi', nom: 'Koffi Kouassi', telephone: '+2250701020304', etat: 'vers_restaurant' });
    expect(r.etapes.map((e) => [e.cle, e.heure])).toEqual([
      ['acceptee', t('12:15')],
      ['arrivee_restaurant', null],
      ['recuperee', null],
      ['arrivee_client', null],
      ['livree', null],
    ]);
  });

  it('proposée : le livreur sollicité est nommé, sans son téléphone', () => {
    const r = suiviLivraison(
      commande(
        {},
        {
          course: course({
            statut: 'PENDING_ASSIGNMENT',
            offer_attempts: [{ expires_at: d('12:20', '30'), deliverer: { id: 'liv-awa', first_name: 'Awa', last_name: 'Traoré' } }],
          }),
        },
      ),
      ctx,
    );
    expect(r.livreur).toEqual({ id: 'liv-awa', nom: 'Awa Traoré', telephone: null, etat: 'proposee' });
    expect(r.etapes.every((e) => e.heure === null)).toBe(true);
  });

  it('recherche : offre échue ou aucune offre, aucun nom', () => {
    const echue = suiviLivraison(
      commande(
        {},
        {
          course: course({
            statut: 'PENDING_ASSIGNMENT',
            offer_attempts: [{ expires_at: d('12:19'), deliverer: { id: 'liv-awa', first_name: 'Awa' } }],
          }),
        },
      ),
      ctx,
    );
    expect(echue.livreur).toEqual({ id: null, nom: null, telephone: null, etat: 'recherche' });
    expect(echue.course?.code_retrait).toBe('614');
  });
});

describe('suivi de livraison : sans course', () => {
  it('commande à livrer sans course : service seul, pas encore de livreur', () => {
    expect(suiviLivraison(commande({ status: 'IN_PROGRESS' }, null), ctx)).toEqual({
      service: 'CHICKEN_NATION',
      course: null,
      livreur: null,
      tournee: [],
      livraison: null,
      echec: null,
      etapes: [],
      durees: { vers_restaurant_s: null, attente_comptoir_s: null, vers_client_s: null, pret_a_livre_s: null },
    });
  });

  it('commande à emporter ou sur place : aucun service', () => {
    expect(suiviLivraison(commande({ type: 'PICKUP' }, null), ctx)).toMatchObject({ service: null, course: null, livreur: null, etapes: [] });
    expect(suiviLivraison(commande({ type: 'TABLE', delivery_service: 'FREE' }, null), ctx).service).toBeNull();
  });

  it('tentative close, commande vivante (course expirée, livraison détachée) : plus de livreur', () => {
    const expiree = suiviLivraison(commande({}, { course: course({ statut: 'EXPIRED' }) }), ctx);
    expect(expiree).toMatchObject({ service: 'CHICKEN_NATION', course: null, livreur: null, etapes: [] });
    const detachee = suiviLivraison(
      commande({}, { statut: 'CANCELLED', course: course({ statut: 'IN_DELIVERY', deliverer: KOFFI }) }),
      ctx,
    );
    expect(detachee).toMatchObject({ course: null, livreur: null, etapes: [] });
  });

  it('ancienne valeur FREE avec une course : flotte interne', () => {
    const r = suiviLivraison(
      commande({ delivery_service: 'FREE' }, { course: course({ statut: 'ACCEPTED', assigned_at: d('12:15'), deliverer: KOFFI }) }),
      ctx,
    );
    expect(r.service).toBe('CHICKEN_NATION');
  });
});

describe('suivi de livraison : Turbo', () => {
  it('course confiée à Turbo : livreur annoncé par Turbo, arrivée au restaurant jamais notée donc omise', () => {
    const r = suiviLivraison(
      commande(
        { delivery_service: 'TURBO', status: 'PICKED_UP', picked_up_at: d('12:16') },
        {
          statut: 'IN_ROUTE',
          turbo_courier_id: 'T-88',
          turbo_courier_name: 'Moussa Diallo',
          turbo_courier_phone: '+2250505050505',
          course: course({
            statut: 'IN_DELIVERY',
            assigned_at: d('12:05'),
            picked_up_at: d('12:16'),
            deliveries: [{ id: 'liv-a', statut: 'IN_ROUTE', sequence_order: 1, order: { status: 'PICKED_UP' } }],
          }),
        },
      ),
      ctx,
    );
    expect(r.service).toBe('TURBO');
    expect(r.livreur).toEqual({ id: 'T-88', nom: 'Moussa Diallo', telephone: '+2250505050505', etat: 'vers_client' });
    expect(r.etapes).toEqual([
      { cle: 'acceptee', heure: t('12:05'), prevue: null },
      { cle: 'recuperee', heure: t('12:16'), prevue: null },
      { cle: 'arrivee_client', heure: null, prevue: null },
      { cle: 'livree', heure: null, prevue: null },
    ]);
    expect(r.durees).toEqual({ vers_restaurant_s: null, attente_comptoir_s: null, vers_client_s: null, pret_a_livre_s: null });
  });

  it('Turbo sans livreur annoncé : nom nul (« Livreur Turbo » à l’écran), recherche', () => {
    const r = suiviLivraison(
      commande({ delivery_service: 'TURBO' }, { course: course({ statut: 'PENDING_ASSIGNMENT' }) }),
      ctx,
    );
    expect(r.livreur).toEqual({ id: null, nom: null, telephone: null, etat: 'recherche' });
  });

  it('Turbo livrée : livraison et durée prête → livrée', () => {
    const r = suiviLivraison(
      commande(
        { delivery_service: 'TURBO', status: 'COMPLETED', picked_up_at: d('12:16'), collected_at: d('12:40') },
        {
          statut: 'DELIVERED',
          delivered_at: d('12:39'),
          turbo_courier_name: 'Moussa Diallo',
          course: course({ statut: 'COMPLETED', assigned_at: d('12:05'), picked_up_at: d('12:16') }),
        },
      ),
      { ...ctx, maintenant: d('12:50') },
    );
    expect(r.livreur?.etat).toBe('livree');
    expect(r.etapes.map((e) => e.cle)).toEqual(['acceptee', 'recuperee', 'livree']);
    expect(r.etapes.at(-1)?.heure).toBe(t('12:39'));
    expect(r.durees.pret_a_livre_s).toBe(39 * 60);
  });

  it('envoi direct à Turbo, sans course chez nous : statuts de la commande seulement', () => {
    expect(suiviLivraison(commande({ delivery_service: 'TURBO', status: 'READY' }, null), ctx)).toMatchObject({
      service: 'TURBO',
      livreur: null,
      etapes: [],
    });
    const enRoute = suiviLivraison(commande({ delivery_service: 'TURBO', status: 'PICKED_UP', picked_up_at: d('12:16') }, null), ctx);
    expect(enRoute.livreur).toEqual({ id: null, nom: null, telephone: null, etat: 'vers_client' });
    expect(enRoute.etapes.map((e) => [e.cle, e.heure])).toEqual([
      ['recuperee', t('12:16')],
      ['arrivee_client', null],
      ['livree', null],
    ]);
    const livree = suiviLivraison(
      commande({ delivery_service: 'TURBO', status: 'COLLECTED', picked_up_at: d('12:16'), collected_at: d('12:41') }, null),
      ctx,
    );
    expect(livree.livreur?.etat).toBe('livree');
    expect(livree.etapes.map((e) => [e.cle, e.heure])).toEqual([
      ['recuperee', t('12:16')],
      ['livree', t('12:41')],
    ]);
    expect(livree.durees.pret_a_livre_s).toBe(41 * 60);
  });
});

describe('suivi de livraison : annulée', () => {
  it('commande annulée après l’acceptation : état annulée, ce qui s’est passé, aucune étape à venir', () => {
    const r = suiviLivraison(
      commande({ status: 'CANCELLED' }, { statut: 'CANCELLED', course: course({ statut: 'CANCELLED', assigned_at: d('12:05'), deliverer: KOFFI }) }),
      ctx,
    );
    expect(r.livreur?.etat).toBe('annulee');
    expect(r.livreur?.nom).toBe('Koffi Kouassi');
    expect(r.etapes).toEqual([{ cle: 'acceptee', heure: t('12:05'), prevue: null }]);
  });

  it('livraison en échec : annulée', () => {
    const r = suiviLivraison(
      commande(
        { status: 'PICKED_UP', picked_up_at: d('12:11') },
        { statut: 'FAILED', arrived_at: d('12:25'), course: course({ statut: 'COMPLETED', assigned_at: d('12:02'), deliverer: KOFFI }) },
      ),
      ctx,
    );
    expect(r.livreur?.etat).toBe('annulee');
    expect(r.etapes.map((e) => e.cle)).toEqual(['acceptee', 'recuperee', 'arrivee_client']);
  });
});

describe('suivi de livraison : durées jamais négatives ni inventées', () => {
  it('heures dans le désordre : durée nulle, pas négative', () => {
    const r = suiviLivraison(
      commande(
        { status: 'COMPLETED', ready_at: d('12:30'), picked_up_at: d('12:11') },
        {
          statut: 'DELIVERED',
          arrived_at: d('12:10'),
          delivered_at: d('12:27'),
          course: course({ statut: 'COMPLETED', assigned_at: d('12:09'), at_restaurant_at: d('12:08'), deliverer: KOFFI }),
        },
      ),
      ctx,
    );
    expect(r.durees).toEqual({ vers_restaurant_s: null, attente_comptoir_s: 180, vers_client_s: null, pret_a_livre_s: null });
  });

  it('arrivée chez le client non notée : aucune durée vers le client, même livrée ; étape omise', () => {
    const r = suiviLivraison(
      commande(
        { status: 'COMPLETED', picked_up_at: d('12:11') },
        {
          statut: 'DELIVERED',
          delivered_at: d('12:27'),
          course: course({ statut: 'COMPLETED', assigned_at: d('12:02'), picked_up_at: d('12:11'), deliverer: KOFFI }),
        },
      ),
      ctx,
    );
    expect(r.durees).toEqual({ vers_restaurant_s: null, attente_comptoir_s: null, vers_client_s: null, pret_a_livre_s: 27 * 60 });
    expect(r.etapes.map((e) => e.cle)).toEqual(['acceptee', 'recuperee', 'livree']);
  });

  it('sans heure de préparation : pas de « prête → livrée »', () => {
    const r = suiviLivraison(
      commande(
        { status: 'COMPLETED', ready_at: null, collected_at: d('12:27') },
        { statut: 'DELIVERED', delivered_at: d('12:27'), course: course({ statut: 'COMPLETED', deliverer: KOFFI }) },
      ),
      ctx,
    );
    expect(r.durees.pret_a_livre_s).toBeNull();
  });
});

// ─── Ajouts du 24/10 (conception, 11.3) ──────────────────────────────────────

/** Course de trois commandes partie à 12:10 (départ réel), tournée estimée à 20 min. */
function tourneeDeTrois(champs: Partial<CourseLivraisonLue> = {}): CourseLivraisonLue {
  return course({
    statut: 'IN_DELIVERY',
    assigned_at: d('11:50'),
    at_restaurant_at: d('11:58'),
    picked_up_at: d('12:05'),
    parti_at: d('12:10'),
    motif_depart: 'POSITION',
    estimated_duration_min: 20,
    deliverer: KOFFI,
    deliveries: [
      {
        id: 'liv-1',
        statut: 'DELIVERED',
        sequence_order: 1,
        in_route_at: d('12:10'),
        arrived_at: d('12:16'),
        delivered_at: d('12:18'),
        order: { reference: 'ORD-4818', status: 'COMPLETED' },
      },
      // Détachée (annulée) : hors de la tournée, les rangs ne comptent pas son trou.
      { id: 'liv-x', statut: 'CANCELLED', sequence_order: 2, order: { reference: 'ORD-4899', status: 'READY' } },
      { id: 'liv-a', statut: 'IN_ROUTE', sequence_order: 3, in_route_at: d('12:18'), order: { reference: 'ORD-4819', status: 'PICKED_UP' } },
      { id: 'liv-3', statut: 'PENDING', sequence_order: 4, order: { reference: 'ORD-4820', status: 'PICKED_UP' } },
    ],
    ...champs,
  });
}

const enRoute = (c: CourseLivraisonLue) =>
  commande({ status: 'PICKED_UP', picked_up_at: d('12:05') }, { id: 'liv-a', statut: 'IN_ROUTE', course: c });

describe('suivi de livraison : tournée (24/10)', () => {
  it('un arrêt par livraison non annulée, dans l’ordre : référence, état, heure de cet état, cette commande marquée', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois()), ctx);
    expect(r.tournee).toEqual([
      { reference: 'ORD-4818', rang: 1, etat: 'livree', heure: t('12:18'), cette_commande: false, reportee: false },
      { reference: 'ORD-4819', rang: 2, etat: 'en_route', heure: t('12:18'), cette_commande: true, reportee: false },
      { reference: 'ORD-4820', rang: 3, etat: 'a_livrer', heure: null, cette_commande: false, reportee: false },
    ]);
    expect(r.course).toMatchObject({ nombre_commandes: 3, rang_arret: 2 });
  });

  it('chez le client, échec : leur heure ; rien des autres clients (ni nom, ni adresse, ni téléphone)', () => {
    const c = tourneeDeTrois({
      deliveries: [
        { id: 'liv-1', statut: 'FAILED', sequence_order: 1, failed_at: d('12:17'), order: { reference: 'ORD-4818', status: 'CANCELLED' } },
        { id: 'liv-a', statut: 'ARRIVED', sequence_order: 2, arrived_at: d('12:19'), order: { reference: 'ORD-4819', status: 'PICKED_UP' } },
      ],
    });
    const r = suiviLivraison(enRoute(c), ctx);
    expect(r.tournee).toEqual([
      { reference: 'ORD-4818', rang: 1, etat: 'echec', heure: t('12:17'), cette_commande: false, reportee: false },
      { reference: 'ORD-4819', rang: 2, etat: 'chez_le_client', heure: t('12:19'), cette_commande: true, reportee: false },
    ]);
    for (const arret of r.tournee) {
      expect(Object.keys(arret).sort()).toEqual(['cette_commande', 'etat', 'heure', 'rang', 'reference', 'reportee']);
    }
  });

  it('sans course, ou Turbo sans course chez nous : tournée vide, aucun échec', () => {
    expect(suiviLivraison(commande({}, null), ctx)).toMatchObject({ tournee: [], echec: null });
    expect(
      suiviLivraison(commande({ delivery_service: 'TURBO', status: 'PICKED_UP', picked_up_at: d('12:10') }, null), ctx),
    ).toMatchObject({ tournee: [], echec: null });
  });
});

describe('suivi de livraison : fin prévue et retard (règle commune, 24/10)', () => {
  it('partie à 12:10, 20 min estimées : fin vers 12:30, pas en retard à 12:20', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois()), ctx);
    expect(r.course).toMatchObject({ fin_prevue: t('12:30'), en_retard: false, retard_min: null });
  });

  it('à 12:47 (retrait 12:05, 20 min × 1,5 = 30 min dépassées) : en retard de 17 min', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois()), { ...ctx, maintenant: d('12:47') });
    expect(r.course).toMatchObject({ fin_prevue: t('12:30'), en_retard: true, retard_min: 17 });
  });

  it('facteur réglé à 2 : pas encore en retard à 12:40', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois()), { ...ctx, maintenant: d('12:40'), facteurRetard: 2 });
    expect(r.course).toMatchObject({ en_retard: false, retard_min: null });
  });

  it('alerte du cron déjà donnée : en retard, même avant le seuil', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois({ delay_alerted_at: d('12:19') })), ctx);
    expect(r.course).toMatchObject({ en_retard: true, retard_min: null });
  });

  it('livreur pas encore parti (fenêtre d’ajout) : pas de fin prévue', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois({ parti_at: null, motif_depart: null })), ctx);
    expect(r.course).toMatchObject({ fin_prevue: null, en_retard: false, retard_min: null });
  });
});

describe('suivi de livraison : échec (24/10)', () => {
  it('livraison de cette commande en échec : motif et note du livreur', () => {
    const r = suiviLivraison(
      commande(
        { status: 'CANCELLED', picked_up_at: d('12:05') },
        {
          statut: 'FAILED',
          failure_reason: 'CLIENT_ABSENT',
          failure_note: '  Personne au portail  ',
          course: tourneeDeTrois(),
        },
      ),
      ctx,
    );
    expect(r.echec).toEqual({ motif: 'CLIENT_ABSENT', note: 'Personne au portail' });
    expect(r.livreur?.etat).toBe('annulee');
  });

  it('livraison pas en échec : rien, même si une autre de la tournée a échoué', () => {
    const c = tourneeDeTrois({
      deliveries: [
        { id: 'liv-1', statut: 'FAILED', sequence_order: 1, failed_at: d('12:17'), order: { reference: 'ORD-4818', status: 'CANCELLED' } },
        { id: 'liv-a', statut: 'IN_ROUTE', sequence_order: 2, order: { reference: 'ORD-4819', status: 'PICKED_UP' } },
      ],
    });
    expect(suiviLivraison(enRoute(c), ctx).echec).toBeNull();
  });

  it('échec sans motif ni note : les deux à null', () => {
    const r = suiviLivraison(commande({ status: 'CANCELLED' }, { statut: 'FAILED', course: tourneeDeTrois() }), ctx);
    expect(r.echec).toEqual({ motif: null, note: null });
  });
});

describe('suivi de livraison : appli du livreur (24/10)', () => {
  const appli = (connectes: string[] | null, appliFermeeApresS = 180) => ({
    appliFermeeApresS,
    connectes: connectes ? new Set(connectes) : null,
  });
  const avec = (livreur: Record<string, unknown>) => enRoute(tourneeDeTrois({ deliverer: { ...KOFFI, ...livreur } }));

  it('appli récente sans socket, vue il y a 6 min, sans preuve de fermeture : connexion coupée, heure du dernier signe de vie', () => {
    const r = suiviLivraison(avec({ protocole_appli: 4, dernier_signal_at: d('12:14') }), { ...ctx, appli: appli([]) });
    expect(r.livreur).toMatchObject({
      appli_active: false,
      appli_vue_a: t('12:14'),
      appli_connectee: false,
      appli_etat: 'COUPURE',
    });
  });

  it('tiroir (25/10) : « Appli fermée » seulement quand l’appli a fermé elle-même son socket', () => {
    const fin = (raison: string) => ({
      ...appli([]),
      finsSocket: new Map([['liv-koffi', { raison, a: d('12:14') }]]),
    });
    const lu = avec({ protocole_appli: 4, dernier_signal_at: d('12:14') });
    expect(suiviLivraison(lu, { ...ctx, appli: fin('client namespace disconnect') }).livreur).toMatchObject({
      appli_active: false,
      appli_etat: 'FERMEE',
    });
    expect(suiviLivraison(lu, { ...ctx, appli: fin('ping timeout') }).livreur).toMatchObject({ appli_etat: 'COUPURE' });
  });

  it('signe de vie récent sans socket : en arrière-plan (active, pas connectée)', () => {
    const r = suiviLivraison(avec({ protocole_appli: 4, dernier_signal_at: d('12:19') }), { ...ctx, appli: appli([]) });
    expect(r.livreur).toMatchObject({ appli_active: true, appli_connectee: false, appli_etat: 'ACTIVE' });
  });

  it('socket ouvert : active et connectée', () => {
    const r = suiviLivraison(avec({ protocole_appli: 4, dernier_signal_at: d('11:00') }), { ...ctx, appli: appli(['liv-koffi']) });
    expect(r.livreur).toMatchObject({ appli_active: true, appli_connectee: true });
  });

  it('ancienne appli, ou règle coupée (réglage à 0) : état inconnu (null) ; présence inconnue : null', () => {
    expect(
      suiviLivraison(avec({ protocole_appli: 3, dernier_signal_at: d('11:00') }), { ...ctx, appli: appli([]) }).livreur,
    ).toMatchObject({ appli_active: null, appli_connectee: false, appli_etat: null });
    expect(
      suiviLivraison(avec({ protocole_appli: 4, dernier_signal_at: d('11:00') }), { ...ctx, appli: appli(null, 0) }).livreur,
    ).toMatchObject({ appli_active: null, appli_connectee: null });
  });

  it('Turbo, livreur sollicité ou sans contexte : aucun champ d’appli ; jamais le signe de vie ni le protocole tels quels', () => {
    const sans = suiviLivraison(avec({ protocole_appli: 4, dernier_signal_at: d('12:14') }), ctx);
    expect(Object.keys(sans.livreur!).sort()).toEqual(['etat', 'id', 'nom', 'telephone']);
    const turbo = suiviLivraison(
      commande(
        { delivery_service: 'TURBO', status: 'PICKED_UP', picked_up_at: d('12:05') },
        { course: course({ statut: 'IN_DELIVERY' }) },
      ),
      { ...ctx, appli: appli([]) },
    );
    expect(Object.keys(turbo.livreur!).sort()).toEqual(['etat', 'id', 'nom', 'telephone']);
    const r = suiviLivraison(avec({ protocole_appli: 4, dernier_signal_at: d('12:14') }), { ...ctx, appli: appli([]) });
    expect(r.livreur).not.toHaveProperty('dernier_signal_at');
    expect(r.livreur).not.toHaveProperty('protocole_appli');
  });
});

// ─── Livraison passée à plus tard par le livreur (27/10) ────────────────────

describe('suivi de livraison : livraison passée à plus tard (27/10)', () => {
  const reportee = (champs: Partial<CourseLivraisonLue> = {}) =>
    tourneeDeTrois({
      deliveries: [
        {
          id: 'liv-1',
          statut: 'DELIVERED',
          sequence_order: 1,
          delivered_at: d('12:18'),
          order: { reference: 'ORD-4818', status: 'COMPLETED' },
        },
        { id: 'liv-3', statut: 'IN_ROUTE', sequence_order: 2, in_route_at: d('12:19'), order: { reference: 'ORD-4820', status: 'PICKED_UP' } },
        {
          id: 'liv-a',
          statut: 'PENDING',
          sequence_order: 3,
          in_route_at: d('12:18'),
          reportee_at: d('12:19'),
          order: { reference: 'ORD-4819', status: 'PICKED_UP' },
        },
      ],
      ...champs,
    });

  it('l’arrêt reste « à livrer » (aucun nouvel état), marqué reporté ; l’heure du report pour cette commande', () => {
    const r = suiviLivraison(
      commande({ status: 'PICKED_UP', picked_up_at: d('12:05') }, { id: 'liv-a', statut: 'PENDING', reportee_at: d('12:19'), course: reportee() }),
      ctx,
    );
    expect(r.tournee.map((a) => [a.reference, a.rang, a.etat, a.reportee])).toEqual([
      ['ORD-4818', 1, 'livree', false],
      ['ORD-4820', 2, 'en_route', false],
      ['ORD-4819', 3, 'a_livrer', true],
    ]);
    expect(r.livraison).toEqual({ reportee_a: t('12:19') });
    expect(r.course).toMatchObject({ rang_arret: 3, nombre_commandes: 3 });
    expect(r.livreur?.etat).toBe('vers_client');
    // Dernier arrêt, mais reporté : pas d'heure prévue (la fin de tournée figée serait trop tôt).
    expect(r.etapes.find((e) => e.cle === 'arrivee_client')).toEqual({ cle: 'arrivee_client', heure: null, prevue: null });
  });

  it('serveur ou course d’avant : rien de reporté', () => {
    const r = suiviLivraison(enRoute(tourneeDeTrois()), ctx);
    expect(r.tournee.every((a) => a.reportee === false)).toBe(true);
    expect(r.livraison).toEqual({ reportee_a: null });
    expect(suiviLivraison(commande({}, null), ctx).livraison).toBeNull();
  });
});
