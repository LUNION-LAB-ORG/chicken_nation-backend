import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { NotificationTarget, NotificationType, UserRole } from '@prisma/client';
import * as request from 'supertest';
import { NotificationsService } from '../services/notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * Chaîne HTTP réelle de la cloche : ValidationPipe global (mêmes options que main.ts), pipes de
 * paramètre, contrôle du propriétaire. Seul le jeton est simulé : l'en-tête x-principal choisit
 * le principal que la garde passeport aurait posé sur req.user.
 */
const MEMBRE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const NOTIF_ID = '33333333-3333-4333-8333-333333333333';

const principaux: Record<string, unknown> = {
  membre: { id: MEMBRE_ID, role: UserRole.CAISSIER },
  client: { id: CLIENT_ID, phone: '+2250700000000' },
};

const gardeSimulee: CanActivate = {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.user = principaux[String(req.headers['x-principal'])];
    return true;
  },
};

describe('NotificationsController, chaîne HTTP', () => {
  let app: INestApplication;
  const service = {
    findByUser: jest.fn(),
    getStatsByUser: jest.fn(),
    findOne: jest.fn(),
    markAsRead: jest.fn(),
    markAsUnread: jest.fn(),
    markAllAsReadByUser: jest.fn(),
    remove: jest.fn(),
    removeAllByUser: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    })
      .overrideGuard(AuthGuard(['jwt', 'jwt-customer']))
      .useValue(gardeSimulee)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    // Écoute unique sur un port libre de la boucle locale : supertest n'ouvre pas un serveur par requête.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    // Ferme aussi les connexions gardées ouvertes par l'agent HTTP, sinon Jest signale un processus qui traîne.
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    for (const methode of Object.values(service)) methode.mockResolvedValue({});
  });

  const membre = { user_id: MEMBRE_ID, target: NotificationTarget.USER };
  const client = { user_id: CLIENT_ID, target: NotificationTarget.CUSTOMER };

  it('les routes retirées ne répondent plus : création, liste globale, réécriture libre', async () => {
    const serveur = app.getHttpServer();

    await request(serveur).post('/notifications').set('x-principal', 'membre').send({}).expect(404);
    await request(serveur).get('/notifications').set('x-principal', 'membre').expect(404);
    await request(serveur)
      .patch(`/notifications/${NOTIF_ID}`)
      .set('x-principal', 'membre')
      .send({ user_id: CLIENT_ID })
      .expect(404);
  });

  it('cloche du backoffice : liste, statistiques, tout lire, lire, non lu, supprimer', async () => {
    const serveur = app.getHttpServer();

    await request(serveur).get(`/notifications/user/${MEMBRE_ID}/USER?page=2`).set('x-principal', 'membre').expect(200);
    expect(service.findByUser).toHaveBeenCalledWith(membre, {
      page: 2,
      limit: undefined,
      type: undefined,
      isRead: undefined,
    });

    await request(serveur).get(`/notifications/stats/${MEMBRE_ID}/USER`).set('x-principal', 'membre').expect(200);
    expect(service.getStatsByUser).toHaveBeenCalledWith(membre);

    await request(serveur)
      .patch(`/notifications/user/${MEMBRE_ID}/USER/read-all`)
      .set('x-principal', 'membre')
      .expect(200);
    expect(service.markAllAsReadByUser).toHaveBeenCalledWith(membre);

    await request(serveur).patch(`/notifications/${NOTIF_ID}/read`).set('x-principal', 'membre').expect(200);
    await request(serveur).patch(`/notifications/${NOTIF_ID}/unread`).set('x-principal', 'membre').expect(200);
    await request(serveur).delete(`/notifications/${NOTIF_ID}`).set('x-principal', 'membre').expect(200);
    expect(service.markAsRead).toHaveBeenCalledWith(NOTIF_ID, membre);
    expect(service.markAsUnread).toHaveBeenCalledWith(NOTIF_ID, membre);
    expect(service.remove).toHaveBeenCalledWith(NOTIF_ID, membre);
  });

  it("appli client : pagination à 10, rafraîchissement à 1000 (plafonné par le service), statistiques", async () => {
    const serveur = app.getHttpServer();

    await request(serveur)
      .get(`/notifications/user/${CLIENT_ID}/CUSTOMER?page=1&limit=10`)
      .set('x-principal', 'client')
      .expect(200);
    await request(serveur)
      .get(`/notifications/user/${CLIENT_ID}/CUSTOMER?page=1&limit=1000`)
      .set('x-principal', 'client')
      .expect(200);
    expect(service.findByUser).toHaveBeenNthCalledWith(1, client, expect.objectContaining({ page: 1, limit: 10 }));
    expect(service.findByUser).toHaveBeenNthCalledWith(2, client, expect.objectContaining({ page: 1, limit: 1000 }));

    await request(serveur).get(`/notifications/stats/${CLIENT_ID}/CUSTOMER`).set('x-principal', 'client').expect(200);
    expect(service.getStatsByUser).toHaveBeenCalledWith(client);
  });

  it("filtres : 'false' reste faux, 'true' reste vrai, le type est contrôlé", async () => {
    const serveur = app.getHttpServer();

    await request(serveur)
      .get(`/notifications/user/${MEMBRE_ID}/USER?isRead=false&type=ORDER`)
      .set('x-principal', 'membre')
      .expect(200);
    expect(service.findByUser).toHaveBeenCalledWith(membre, {
      page: undefined,
      limit: undefined,
      type: NotificationType.ORDER,
      isRead: false,
    });

    await request(serveur).get(`/notifications/user/${MEMBRE_ID}/USER?isRead=true`).set('x-principal', 'membre').expect(200);
    expect(service.findByUser).toHaveBeenLastCalledWith(membre, expect.objectContaining({ isRead: true }));

    await request(serveur)
      .get(`/notifications/user/${MEMBRE_ID}/USER?type=INCONNU`)
      .set('x-principal', 'membre')
      .expect(400);
    await request(serveur)
      .get(`/notifications/user/${MEMBRE_ID}/USER?page=abc`)
      .set('x-principal', 'membre')
      .expect(400);
  });

  it("une cible hors énumération répond 400 au lieu de descendre jusqu'à Prisma", async () => {
    await request(app.getHttpServer())
      .get(`/notifications/user/${MEMBRE_ID}/user`)
      .set('x-principal', 'membre')
      .expect(400);
    expect(service.findByUser).not.toHaveBeenCalled();
  });

  it("la cloche d'un autre, ou sa propre identité avec l'autre cible, répond 403", async () => {
    const serveur = app.getHttpServer();

    await request(serveur).get(`/notifications/user/${CLIENT_ID}/CUSTOMER`).set('x-principal', 'membre').expect(403);
    await request(serveur).get(`/notifications/stats/${MEMBRE_ID}/USER`).set('x-principal', 'client').expect(403);
    await request(serveur).get(`/notifications/user/${CLIENT_ID}/USER`).set('x-principal', 'client').expect(403);
    await request(serveur)
      .patch(`/notifications/user/${MEMBRE_ID}/CUSTOMER/read-all`)
      .set('x-principal', 'membre')
      .expect(403);
    await request(serveur).delete(`/notifications/user/${CLIENT_ID}/CUSTOMER`).set('x-principal', 'membre').expect(403);

    expect(service.findByUser).not.toHaveBeenCalled();
    expect(service.getStatsByUser).not.toHaveBeenCalled();
    expect(service.markAllAsReadByUser).not.toHaveBeenCalled();
    expect(service.removeAllByUser).not.toHaveBeenCalled();
  });

  it('sans principal, même une route par identifiant répond 403', async () => {
    await request(app.getHttpServer()).get(`/notifications/${NOTIF_ID}`).expect(403);
    expect(service.findOne).not.toHaveBeenCalled();
  });
});
