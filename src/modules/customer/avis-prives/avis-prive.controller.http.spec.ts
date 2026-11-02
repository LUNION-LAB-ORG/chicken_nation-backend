/**
 * Routage des retours privés par HTTP.
 *
 * Nest déclare les routes dans l'ordre des méthodes du contrôleur : une route
 * fixe placée APRÈS `GET :id` serait prise pour un identifiant d'avis.
 * Ici, `compteurs`, `export` et `agents` doivent atteindre leur méthode, et
 * l'envoi public garde sa limite par IP et son champ piège.
 */
import { CanActivate, ExecutionContext, INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserRole, UserType } from '@prisma/client';
import * as request from 'supertest';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { AvisPriveDepotService } from './avis-prive-depot.service';
import { AvisPriveTraitementService } from './avis-prive-traitement.service';
import { AvisPriveController } from './avis-prive.controller';
import { MESSAGE_PLAFOND_IP } from './avis-prive.rules';
import { AvisPriveService } from './avis-prive.service';

class AdministrateurConnecte implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = {
      id: 'u-admin',
      role: UserRole.ADMIN,
      type: UserType.BACKOFFICE,
      restaurant_id: null,
    };
    return true;
  }
}

const methodes = Object.getOwnPropertyNames(AvisPriveController.prototype);
const handler = (nom: string) => (AvisPriveController.prototype as unknown as Record<string, object>)[nom];

describe('AvisPriveController : ordre des routes', () => {
  it.each([
    ['compteurs', 'compteurs'],
    ['export', 'exporter'],
    ['agents', 'agents'],
  ])('GET %s est déclarée AVANT GET :id', (chemin, nom) => {
    expect(Reflect.getMetadata(PATH_METADATA, handler(nom))).toBe(chemin);
    expect(Reflect.getMetadata(METHOD_METADATA, handler(nom))).toBe(RequestMethod.GET);
    expect(methodes.indexOf(nom)).toBeLessThan(methodes.indexOf('fiche'));
  });
});

describe('AvisPriveController par HTTP', () => {
  let app: INestApplication;
  const lecture = {
    compteurs: jest.fn(async () => ({ nouveaux: 1, a_rappeler: 2, echeance_depassee: 0, resolus_7j: 3, a_traiter: 3 })),
    exporter: jest.fn(async () => ({ nom: 'avis-prives-2026-11-02.csv', type: 'text/csv; charset=utf-8', contenu: Buffer.from('﻿Reçu le') })),
    agents: jest.fn(async () => [{ id: 'u-cc', fullname: 'Gbonhi Max' }]),
    liste: jest.fn(async () => ({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } })),
    fiche: jest.fn(async () => ({ id: 'fiche' })),
  };
  const depot = { deposer: jest.fn(async () => ({ ok: true })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Même enregistrement que app.module.ts : le @Throttle de la route remplace le défaut.
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
      controllers: [AvisPriveController],
      providers: [
        { provide: AvisPriveService, useValue: lecture },
        { provide: AvisPriveTraitementService, useValue: {} },
        { provide: AvisPriveDepotService, useValue: depot },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(AdministrateurConnecte)
      .compile();
    app = moduleRef.createNestApplication();
    // Même pipe global que main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  it('compteurs, export et agents ne sont pas lus comme un identifiant d’avis', async () => {
    const http = request(app.getHttpServer());
    await http.get('/avis-prives/compteurs').expect(200, { nouveaux: 1, a_rappeler: 2, echeance_depassee: 0, resolus_7j: 3, a_traiter: 3 });
    const csv = await http.get('/avis-prives/export').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="avis-prives-2026-11-02.csv"');
    await http.get('/avis-prives/agents').expect(200, [{ id: 'u-cc', fullname: 'Gbonhi Max' }]);
    expect(lecture.fiche).not.toHaveBeenCalled();
  });

  it('un identifiant qui n’est pas un uuid : 400, jamais la fiche', async () => {
    await request(app.getHttpServer()).get('/avis-prives/pas-un-id').expect(400);
    expect(lecture.fiche).not.toHaveBeenCalled();
  });

  it('filtres de liste mal formés : 400', async () => {
    await request(app.getHttpServer()).get('/avis-prives?periode=hier').expect(400);
    await request(app.getHttpServer()).get('/avis-prives?restaurantId=tous').expect(400);
    await request(app.getHttpServer()).get('/avis-prives?limit=500').expect(400);
  });

  const corps = {
    ressenti: 'PAS_CONTENT',
    canal: 'TELEPHONE',
    restaurant_id: null,
    commentaire: 'Frites froides.',
    telephone: '+2250707000001',
    prenom: 'Awa',
    accord_rappel: true,
    source: 'marque-page',
  };

  it('envoi public : le champ piège arrive jusqu’au service, un champ inconnu est retiré', async () => {
    depot.deposer.mockClear();
    await request(app.getHttpServer())
      .post('/avis-prives')
      .set('X-Forwarded-For', '198.51.100.20')
      .send({ ...corps, site_web: 'http://spam.example', admin: true })
      .expect(201, { ok: true });
    const recu = (depot.deposer.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(recu.site_web).toBe('http://spam.example');
    expect(recu).not.toHaveProperty('admin');
  });

  it('envoi public : messages de validation en français', async () => {
    const res = await request(app.getHttpServer())
      .post('/avis-prives')
      .send({ ...corps, ressenti: 'FURIEUX', canal: undefined, commentaire: ' x ' })
      .expect(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining(['Choisis ton ressenti.', 'Choisis comment tu avais commandé.', "Raconte-nous ce qui s'est passé."]),
    );
  });

  it('envoi public : 5 envois par IP en 15 minutes, le 6e refusé en français', async () => {
    // Nouvelle application : un compteur par IP tout neuf.
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
      controllers: [AvisPriveController],
      providers: [
        { provide: AvisPriveService, useValue: lecture },
        { provide: AvisPriveTraitementService, useValue: {} },
        { provide: AvisPriveDepotService, useValue: depot },
      ],
    }).compile();
    const autre = moduleRef.createNestApplication();
    autre.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await autre.listen(0, '127.0.0.1');
    try {
      for (let i = 0; i < 5; i++) {
        await request(autre.getHttpServer()).post('/avis-prives').send(corps).expect(201);
      }
      const refus = await request(autre.getHttpServer()).post('/avis-prives').send(corps).expect(429);
      expect(refus.body.message).toBe(MESSAGE_PLAFOND_IP);
    } finally {
      autre.getHttpServer().closeAllConnections();
      await autre.close();
    }
  });
});
