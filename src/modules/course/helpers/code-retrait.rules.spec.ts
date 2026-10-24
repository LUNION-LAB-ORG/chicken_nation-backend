/**
 * Règles du code de retrait (incident du 22/10 : même code dans deux
 * restaurants, la caisse tombait sur la course de l'autre).
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, UserRole, UserType } from '@prisma/client';

// Évaluation des `where` en mémoire, relations `some` et `notIn` comprises.
import { evaluer as correspond } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import {
  CodeDuJour,
  MESSAGE_AUTRE_RESTAURANT,
  MESSAGE_CODE_EN_DOUBLE,
  MESSAGE_CODE_INTROUVABLE,
  MESSAGE_CODE_INTROUVABLE_RESEAU,
  MESSAGE_CODE_PLUSIEURS_RESTAURANTS,
  MESSAGE_SANS_RESTAURANT,
  TOUS_LES_CODES_RETRAIT,
  choisirCodeRetrait,
  messageCodeEnDouble,
  messageCommandesPasPretes,
  restaurantDuRetrait,
  retenirCourseARemettre,
  whereCoursesARemettre,
} from './code-retrait.rules';
import { journeeDeService } from './journee-service.rules';

const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const pris = (codes: string[], statut: CourseStatut = CourseStatut.ACCEPTED): CodeDuJour[] =>
  codes.map((pickup_code) => ({ pickup_code, statut }));

describe('choisirCodeRetrait', () => {
  it('rend toujours 3 chiffres', () => {
    for (let i = 0; i < 200; i++) {
      expect(choisirCodeRetrait([]).code).toMatch(/^\d{3}$/);
    }
  });

  it('ne rend jamais un code déjà pris dans la journée, quel que soit son statut', () => {
    const dejaPris = [
      ...pris(TOUS_LES_CODES_RETRAIT.slice(0, 400), CourseStatut.COMPLETED),
      ...pris(TOUS_LES_CODES_RETRAIT.slice(400, 990), CourseStatut.CANCELLED),
      ...pris(TOUS_LES_CODES_RETRAIT.slice(990, 995), CourseStatut.AT_RESTAURANT),
    ];
    const interdits = new Set(dejaPris.map((c) => c.pickup_code));
    for (let i = 0; i < 300; i++) {
      const choix = choisirCodeRetrait(dejaPris);
      expect(choix.repli).toBeNull();
      expect(interdits.has(choix.code)).toBe(false);
    }
  });

  it('tire au hasard parmi les codes libres', () => {
    const dejaPris = pris(['000', '001', '003']);
    expect(choisirCodeRetrait(dejaPris, () => 0).code).toBe('002');
    expect(choisirCodeRetrait(dejaPris, () => 0.999999).code).toBe('999');
    const vus = new Set(Array.from({ length: 200 }, () => choisirCodeRetrait(dejaPris).code));
    expect(vus.size).toBeGreaterThan(100);
  });

  it('un seul code libre : c\'est lui', () => {
    const dejaPris = pris(TOUS_LES_CODES_RETRAIT.filter((c) => c !== '742'));
    expect(choisirCodeRetrait(dejaPris)).toEqual({ code: '742', repli: null });
  });

  it('les 1 000 codes ont servi : repli sur le code d\'une course terminée', () => {
    const dejaPris = [
      ...pris(TOUS_LES_CODES_RETRAIT.filter((c) => c !== '123' && c !== '456')),
      { pickup_code: '123', statut: CourseStatut.COMPLETED },
      { pickup_code: '456', statut: CourseStatut.EXPIRED },
      // Même code qu'une course terminée, mais encore en cours ailleurs dans la journée.
      { pickup_code: '456', statut: CourseStatut.PENDING_ASSIGNMENT },
    ];
    for (let i = 0; i < 50; i++) {
      expect(choisirCodeRetrait(dejaPris)).toEqual({ code: '123', repli: 'CODE_DE_COURSE_TERMINEE' });
    }
  });

  it('1 000 courses en cours à la fois : repli sur un code quelconque, signalé', () => {
    const choix = choisirCodeRetrait(pris([...TOUS_LES_CODES_RETRAIT]), () => 0.5);
    expect(choix).toEqual({ code: '500', repli: 'CODE_EN_COURS' });
  });
});

describe('whereCoursesARemettre (évalué sur des courses en mémoire)', () => {
  const maintenant = new Date('2026-10-22T13:00:00.000Z');
  const journee = journeeDeService(maintenant);
  const aujourdhui = new Date('2026-10-22T12:30:00.000Z');
  const hier = new Date('2026-10-21T20:00:00.000Z');

  const course = (id: string, surcharge: Record<string, unknown> = {}) => ({
    id,
    pickup_code: '421',
    restaurant_id: RESTO_A,
    statut: CourseStatut.ACCEPTED,
    turbo_escalated_at: null,
    created_at: aujourdhui,
    ...surcharge,
  });

  const courses = [
    course('a-acceptee'),
    course('a-au-restaurant', { statut: CourseStatut.AT_RESTAURANT }),
    course('a-turbo-en-attente', {
      statut: CourseStatut.PENDING_ASSIGNMENT,
      turbo_escalated_at: new Date('2026-10-22T12:35:00.000Z'),
    }),
    course('a-interne-en-attente', { statut: CourseStatut.PENDING_ASSIGNMENT }),
    course('a-en-livraison', { statut: CourseStatut.IN_DELIVERY }),
    course('a-terminee', { statut: CourseStatut.COMPLETED }),
    course('a-hier-encore-active', { created_at: hier }),
    course('a-autre-code', { pickup_code: '422' }),
    course('b-meme-code', { restaurant_id: RESTO_B, statut: CourseStatut.AT_RESTAURANT }),
    // Retrait complémentaire (planificateur v2) : récupérée, livreur encore au
    // restaurant, une commande prête à remettre.
    course('a-recuperee-complement', {
      statut: CourseStatut.IN_DELIVERY,
      parti_at: null,
      deliveries: [
        { statut: DeliveryStatut.PENDING, order: { status: OrderStatus.PICKED_UP } },
        { statut: DeliveryStatut.PENDING, order: { status: OrderStatus.READY } },
      ],
    }),
    // Partie : une commande AJOUTÉE pas remise (détachée au départ, jamais remise avec le code).
    course('a-recuperee-partie', {
      statut: CourseStatut.IN_DELIVERY,
      parti_at: new Date('2026-10-22T12:50:00.000Z'),
      deliveries: [
        { statut: DeliveryStatut.PENDING, ajoutee_apres_retrait: false, order: { status: OrderStatus.PICKED_UP } },
        { statut: DeliveryStatut.PENDING, ajoutee_apres_retrait: true, order: { status: OrderStatus.READY } },
      ],
    }),
    // Sac oublié (relecture du 24/10) : partie sans une commande d'ORIGINE encore prête ; le livreur revient.
    course('a-partie-sac-oublie', {
      statut: CourseStatut.IN_DELIVERY,
      parti_at: new Date('2026-10-22T12:50:00.000Z'),
      deliveries: [
        { statut: DeliveryStatut.DELIVERED, ajoutee_apres_retrait: false, order: { status: OrderStatus.COMPLETED } },
        { statut: DeliveryStatut.PENDING, ajoutee_apres_retrait: false, order: { status: OrderStatus.READY } },
      ],
    }),
    // Partie, commande d'origine prête mais livraison annulée : rien à remettre.
    course('a-partie-livraison-annulee', {
      statut: CourseStatut.IN_DELIVERY,
      parti_at: new Date('2026-10-22T12:50:00.000Z'),
      deliveries: [{ statut: DeliveryStatut.CANCELLED, ajoutee_apres_retrait: false, order: { status: OrderStatus.READY } }],
    }),
    course('a-recuperee-tout-remis', {
      statut: CourseStatut.IN_DELIVERY,
      parti_at: null,
      deliveries: [{ statut: DeliveryStatut.PENDING, order: { status: OrderStatus.PICKED_UP } }],
    }),
  ];

  const trouvees = (restaurantId?: string) =>
    courses.filter((c) => correspond(c, whereCoursesARemettre('421', restaurantId, journee))).map((c) => c.id);

  it('restaurant connu : ses seules courses à remettre de la journée', () => {
    expect(trouvees(RESTO_A)).toEqual([
      'a-acceptee',
      'a-au-restaurant',
      'a-turbo-en-attente',
      'a-recuperee-complement',
      'a-partie-sac-oublie',
    ]);
  });

  it('sac oublié : partie, retrouvée par le code seulement pour une commande d\'origine encore prête', () => {
    expect(trouvees(RESTO_A)).toContain('a-partie-sac-oublie');
    expect(trouvees(RESTO_A)).not.toContain('a-recuperee-partie');
    expect(trouvees(RESTO_A)).not.toContain('a-partie-livraison-annulee');
  });

  it('retrait complémentaire : récupérée seulement si le livreur est encore là et qu\'une commande est prête', () => {
    expect(trouvees(RESTO_A)).toContain('a-recuperee-complement');
    expect(trouvees(RESTO_A)).not.toContain('a-recuperee-partie');
    expect(trouvees(RESTO_A)).not.toContain('a-recuperee-tout-remis');
    expect(trouvees(RESTO_A)).not.toContain('a-en-livraison');
  });

  it('même code dans un autre restaurant : jamais vu depuis le premier', () => {
    expect(trouvees(RESTO_A)).not.toContain('b-meme-code');
    expect(trouvees(RESTO_B)).toEqual(['b-meme-code']);
  });

  it('course d\'hier restée active : ignorée', () => {
    expect(trouvees(RESTO_A)).not.toContain('a-hier-encore-active');
    expect(trouvees(undefined)).not.toContain('a-hier-encore-active');
  });

  it('sans restaurant : tous les restaurants de la journée', () => {
    expect(trouvees(undefined)).toEqual([
      'a-acceptee',
      'a-au-restaurant',
      'a-turbo-en-attente',
      'b-meme-code',
      'a-recuperee-complement',
      'a-partie-sac-oublie',
    ]);
  });
});

describe('restaurantDuRetrait', () => {
  const caissiere = { id: 'c1', role: UserRole.CAISSIER, type: UserType.RESTAURANT, restaurant_id: RESTO_A };
  const manager = { id: 'm1', role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: RESTO_A };
  const admin = { id: 'a1', role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null };

  it('caissière : son restaurant, même sans rien envoyer (caisse Sunmi)', () => {
    expect(restaurantDuRetrait(caissiere)).toBe(RESTO_A);
    expect(restaurantDuRetrait(caissiere, RESTO_A)).toBe(RESTO_A);
    expect(restaurantDuRetrait(manager, undefined)).toBe(RESTO_A);
  });

  it('caissière qui demande un autre restaurant : 403', () => {
    expect(() => restaurantDuRetrait(caissiere, RESTO_B)).toThrow(ForbiddenException);
    expect(() => restaurantDuRetrait(caissiere, RESTO_B)).toThrow(MESSAGE_AUTRE_RESTAURANT);
  });

  it('compte de restaurant sans restaurant rattaché : 403, jamais tout le réseau', () => {
    const orphelin = { ...caissiere, restaurant_id: null };
    expect(() => restaurantDuRetrait(orphelin)).toThrow(MESSAGE_SANS_RESTAURANT);
    // Rôle de point de vente mal typé : reconnu par son rôle.
    const malType = { ...caissiere, type: UserType.BACKOFFICE };
    expect(restaurantDuRetrait(malType, undefined)).toBe(RESTO_A);
    expect(() => restaurantDuRetrait(malType, RESTO_B)).toThrow(ForbiddenException);
  });

  it('admin : le restaurant demandé, sinon tous', () => {
    expect(restaurantDuRetrait(admin, RESTO_B)).toBe(RESTO_B);
    expect(restaurantDuRetrait(admin)).toBeUndefined();
    expect(restaurantDuRetrait(admin, '')).toBeUndefined();
  });
});

describe('retenirCourseARemettre', () => {
  const a1 = { id: 'a1', restaurant_id: RESTO_A };
  const a2 = { id: 'a2', restaurant_id: RESTO_A };
  const b1 = { id: 'b1', restaurant_id: RESTO_B };

  it('aucune : 404 au message de la caisse', () => {
    expect(() => retenirCourseARemettre([], RESTO_A)).toThrow(NotFoundException);
    expect(() => retenirCourseARemettre([], RESTO_A)).toThrow(MESSAGE_CODE_INTROUVABLE);
    expect(() => retenirCourseARemettre([], undefined)).toThrow(MESSAGE_CODE_INTROUVABLE_RESEAU);
  });

  it('une : c\'est elle', () => {
    expect(retenirCourseARemettre([b1], undefined)).toBe(b1);
  });

  it('plusieurs restaurants : 409, choisir le restaurant', () => {
    expect(() => retenirCourseARemettre([a1, b1], undefined)).toThrow(ConflictException);
    expect(() => retenirCourseARemettre([a1, b1], undefined)).toThrow(MESSAGE_CODE_PLUSIEURS_RESTAURANTS);
  });

  it('deux dans le même restaurant (courses d\'avant la règle) : 409, jamais au hasard', () => {
    expect(() => retenirCourseARemettre([a1, a2], RESTO_A)).toThrow(ConflictException);
    expect(() => retenirCourseARemettre([a1, a2], RESTO_A)).toThrow(MESSAGE_CODE_EN_DOUBLE);
  });

  it('doublon dans le même restaurant : les références sont données à l\'administrateur', () => {
    const r1 = { ...a1, reference: 'CRS-261022-11111' };
    const r2 = { ...a2, reference: 'CRS-261022-22222' };
    expect(() => retenirCourseARemettre([r1, r2], RESTO_A)).toThrow(
      "Plusieurs courses en cours portent ce code dans ce restaurant aujourd'hui (CRS-261022-11111 et CRS-261022-22222) : prévenez un administrateur.",
    );
  });

  it('les messages sont ceux attendus par la caisse', () => {
    expect(MESSAGE_CODE_INTROUVABLE).toBe(
      "Aucune course en cours avec ce code dans ce restaurant aujourd'hui. Vérifiez le code dicté par le livreur.",
    );
    expect(MESSAGE_CODE_PLUSIEURS_RESTAURANTS).toBe(
      'Ce code existe dans plusieurs restaurants : choisissez le restaurant.',
    );
  });
});

describe('messageCommandesPasPretes', () => {
  it('nomme la commande et son statut en français', () => {
    expect(messageCommandesPasPretes([{ reference: 'ORD-261022-00042', status: OrderStatus.IN_PROGRESS }])).toBe(
      'La commande ORD-261022-00042 est encore « En préparation » : marquez-la prête avant de la remettre.',
    );
    expect(messageCommandesPasPretes([{ reference: 'ORD-1', status: OrderStatus.ACCEPTED }])).toBe(
      'La commande ORD-1 est encore « Nouvelle » : marquez-la prête avant de la remettre.',
    );
  });

  it('commande déjà partie : les mots de la page Commandes', () => {
    expect(messageCommandesPasPretes([{ reference: 'ORD-1', status: OrderStatus.COLLECTED }])).toBe(
      'La commande ORD-1 est « Récupérée » : elle ne peut pas être remise au livreur.',
    );
    expect(messageCommandesPasPretes([{ reference: 'ORD-1', status: OrderStatus.PICKED_UP }])).toBe(
      'La commande ORD-1 est « En livraison » : elle ne peut pas être remise au livreur.',
    );
  });

  it('commande annulée : ne dit pas de la marquer prête', () => {
    expect(messageCommandesPasPretes([{ reference: 'ORD-1', status: OrderStatus.CANCELLED }])).toBe(
      'La commande ORD-1 est « Annulée » : elle ne peut pas être remise au livreur.',
    );
  });

  it('plusieurs commandes : toutes nommées', () => {
    expect(
      messageCommandesPasPretes([
        { reference: 'ORD-1', status: OrderStatus.IN_PROGRESS },
        { reference: 'ORD-2', status: OrderStatus.PENDING },
        { reference: 'ORD-3', status: OrderStatus.ACCEPTED },
      ]),
    ).toBe(
      'Les commandes ORD-1 (« En préparation »), ORD-2 (« En attente ») et ORD-3 (« Nouvelle ») ne sont pas encore prêtes : marquez-les prêtes avant de les remettre.',
    );
  });

  it('aucun tiret cadratin dans les textes', () => {
    const textes = [
      MESSAGE_CODE_INTROUVABLE,
      MESSAGE_CODE_INTROUVABLE_RESEAU,
      MESSAGE_CODE_PLUSIEURS_RESTAURANTS,
      MESSAGE_CODE_EN_DOUBLE,
      MESSAGE_AUTRE_RESTAURANT,
      MESSAGE_SANS_RESTAURANT,
      messageCodeEnDouble(['CRS-1', 'CRS-2']),
      messageCommandesPasPretes([{ reference: 'ORD-1', status: OrderStatus.PICKED_UP }]),
    ];
    for (const texte of textes) expect(texte).not.toMatch(/[—–]/);
  });
});
