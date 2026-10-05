/**
 * Routes publiques de lecture avant commande (frais, itinéraire, état de la
 * livraison, conditions de commande).
 *
 * Nest déclare les routes dans l'ordre des méthodes du contrôleur. Une route
 * fixe placée APRÈS `@Get(':id')` serait prise pour un identifiant de
 * commande, et tomberait sur la garde du personnel : le site et
 * l'application recevraient un 401 au lieu de la réponse.
 */

import { CacheModule } from '@nestjs/cache-manager';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { PrismaService } from 'src/database/services/prisma.service';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtStrategy } from 'src/modules/auth/strategies/jwt.strategy';
import { DELIVERY_FEE_DEFAULT_GRID } from '../helpers/delivery-fee.helper';
import { KkiapayOrderListenerService } from '../listeners/kkiapay-order.listener.service';
import { OrderService } from '../services/order.service';
import { ReceiptsService } from '../services/receipts.service';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { OrderController } from './order.controller';

const ROUTES_PUBLIQUES = [
  ['/itineraire-livraison', 'obtenirItineraireLivraison'],
  ['/frais-livraison', 'obtenirFraisLivraison'],
  ['/livraison-disponible', 'obtenirDisponibiliteLivraison'],
  ['/conditions-commande', 'obtenirConditionsCommande'],
] as const;

const methodes = Object.getOwnPropertyNames(OrderController.prototype);
const handler = (nom: string) => (OrderController.prototype as unknown as Record<string, object>)[nom];

describe('Routes publiques de commande', () => {
  it.each(ROUTES_PUBLIQUES)('GET %s est déclarée AVANT GET :id', (chemin, nom) => {
    expect(Reflect.getMetadata(PATH_METADATA, handler(nom))).toBe(chemin);
    expect(Reflect.getMetadata(METHOD_METADATA, handler(nom))).toBe(RequestMethod.GET);
    expect(methodes.indexOf(nom)).toBeGreaterThanOrEqual(0);
    expect(methodes.indexOf(nom)).toBeLessThan(methodes.indexOf('findOne'));
  });

  it.each(ROUTES_PUBLIQUES)('GET %s ne demande aucune connexion', (_chemin, nom) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(nom))).toBeUndefined();
  });

  it('GET :id reste réservée au personnel connecté', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('findOne'))).toContain(JwtAuthGuard);
  });
});

describe('OrderService.obtenirDisponibiliteLivraison', () => {
  const monter = (blocage: { disabled: boolean; message: string }) => {
    const service = Object.create(OrderService.prototype) as OrderService;
    Object.assign(service, {
      deliveryFeeHelper: { isAppDeliveryDisabled: jest.fn().mockResolvedValue(blocage) },
    });
    return service;
  };

  it('livraison ouverte : disponible, sans message', async () => {
    await expect(monter({ disabled: false, message: '' }).obtenirDisponibiliteLivraison()).resolves.toEqual({
      disponible: true,
      message: null,
    });
  });

  it('livraison coupée : le message du réglage, tel que le refus de createv2 le donnerait', async () => {
    const message = 'La livraison reprend à 18 h. Choisissez « À emporter ».';
    await expect(monter({ disabled: true, message }).obtenirDisponibiliteLivraison()).resolves.toEqual({
      disponible: false,
      message,
    });
  });
});

describe('OrderService.obtenirConditionsCommande', () => {
  const monter = (taux: number, reglages: Record<string, unknown>) => {
    const service = Object.create(OrderService.prototype) as OrderService;
    Object.assign(service, {
      orderHelperV2: { getTaxRate: jest.fn().mockResolvedValue(taux) },
      deliveryFeeHelper: { load: jest.fn().mockResolvedValue(reglages) },
    });
    return service;
  };

  // Réglages de livraison complets, tels que DeliveryFeeHelper.load() les rend :
  // le service de livraison par restaurant n'a rien à faire dans une réponse publique.
  const reglages = (turboZonesEnabled: boolean) => ({
    turboZonesEnabled,
    grid: [
      { maxKm: null, price: 3000 },
      { maxKm: 2, price: 1000 },
    ],
    defaultService: 'TURBO',
    serviceByRestaurant: { 'restaurant-1': 'CHICKEN_NATION' },
  });

  it('le taux de createv2 et la grille facturée, sans rien d\'autre', async () => {
    const conditions = await monter(0.01, reglages(false)).obtenirConditionsCommande();
    expect(conditions).toEqual({
      taux_frais_service: 0.01,
      grille_frais: [
        { distance_max_km: 2, montant: 1000 },
        { distance_max_km: null, montant: 3000 },
      ],
      grille_frais_appliquee: true,
    });
    expect(JSON.stringify(conditions)).not.toMatch(/TURBO|CHICKEN_NATION|restaurant-1/);
  });

  it('zones du livreur actives : grille signalée non appliquée', async () => {
    const conditions = await monter(0.01, reglages(true)).obtenirConditionsCommande();
    expect(conditions.grille_frais_appliquee).toBe(false);
  });

  it('taux illisible (réglage mal saisi) : null, le site écrit « calculés au paiement »', async () => {
    const conditions = await monter(Number.NaN, reglages(false)).obtenirConditionsCommande();
    expect(conditions.taux_frais_service).toBeNull();
  });
});

/**
 * Chaîne HTTP réelle : vraie garde du personnel (stratégie passeport `jwt`
 * avec un secret de test), vrai cache cloisonné du contrôleur. Prouve sans
 * redémarrer l'API de test que la route publique répond sans jeton, et que
 * `GET /orders/:id` reste fermée.
 */
describe('GET /orders/conditions-commande, chaîne HTTP', () => {
  let app: INestApplication;
  const ID_COMMANDE = '33333333-3333-4333-8333-333333333333';
  const reponse = {
    taux_frais_service: 0.01,
    grille_frais: DELIVERY_FEE_DEFAULT_GRID.map((p) => ({ distance_max_km: p.maxKm, montant: p.price })),
    grille_frais_appliquee: false,
  };
  const service = {
    obtenirConditionsCommande: jest.fn(),
    findById: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.register(), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
      controllers: [OrderController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { get: () => 'secret-de-test' } },
        { provide: PrismaService, useValue: {} },
        { provide: OrderService, useValue: service },
        { provide: KkiapayService, useValue: {} },
        { provide: ReceiptsService, useValue: {} },
        { provide: OrderWebSocketService, useValue: {} },
        { provide: KkiapayOrderListenerService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    service.obtenirConditionsCommande.mockResolvedValue(reponse);
  });

  it('répond 200 sans jeton, avec les conditions du service', async () => {
    const res = await request(app.getHttpServer()).get('/orders/conditions-commande').expect(200);
    expect(res.body).toEqual(reponse);
    expect(service.obtenirConditionsCommande).toHaveBeenCalledTimes(1);
  });

  it('un jeton invalide (client déconnecté, jeton périmé) ne la ferme pas', async () => {
    await request(app.getHttpServer())
      .get('/orders/conditions-commande')
      .set('Authorization', 'Bearer jeton-invalide')
      .expect(200);
  });

  it('GET /orders/:id répond toujours 401 sans jeton, sans lire la commande', async () => {
    await request(app.getHttpServer()).get(`/orders/${ID_COMMANDE}`).expect(401);
    expect(service.findById).not.toHaveBeenCalled();
  });
});
