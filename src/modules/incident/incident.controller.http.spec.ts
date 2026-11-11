/**
 * Incidents par HTTP : ordre des routes, rôles, validation des corps.
 *
 * Nest déclare les routes dans l'ordre des méthodes du contrôleur : une route
 * fixe placée APRÈS `GET :id` serait prise pour un identifiant d'incident.
 */
import { CanActivate, ExecutionContext, INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { UserRole, UserType } from '@prisma/client';
import * as request from 'supertest';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { IncidentReglagesService } from './incident-reglages.service';
import { IncidentTraitementService } from './incident-traitement.service';
import { IncidentController } from './incident.controller';
import { IncidentService } from './incident.service';

/** Compte connecté, changé d'un test à l'autre. */
let role: UserRole = UserRole.CALL_CENTER;
class CompteConnecte implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const restaurant = ([UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER, UserRole.CUISINE] as UserRole[]).includes(role);
    context.switchToHttp().getRequest().user = {
      id: `u-${role}`,
      role,
      type: restaurant ? UserType.RESTAURANT : UserType.BACKOFFICE,
      restaurant_id: restaurant ? 'resto-1' : null,
      fullname: 'Test',
    };
    return true;
  }
}

const UUID = '11111111-1111-4111-8111-111111111111';
const methodes = Object.getOwnPropertyNames(IncidentController.prototype);
const handler = (nom: string) => (IncidentController.prototype as unknown as Record<string, object>)[nom];

describe('IncidentController : ordre des routes', () => {
  it.each([
    ['reglages', 'reglages'],
    ['compteurs', 'compteurs'],
    ['tableau', 'tableau'],
    ['statistiques', 'statistiques'],
    ['export', 'exporter'],
    ['agents', 'agents'],
    ['commandes', 'commandes'],
    ['commande/:orderId', 'parCommande'],
    ['ouverts', 'ouverts'],
  ])('GET %s est déclarée AVANT GET :id', (chemin, nom) => {
    expect(Reflect.getMetadata(PATH_METADATA, handler(nom))).toBe(chemin);
    expect(Reflect.getMetadata(METHOD_METADATA, handler(nom))).toBe(RequestMethod.GET);
    expect(methodes.indexOf(nom)).toBeLessThan(methodes.indexOf('fiche'));
  });
});

describe('IncidentController par HTTP', () => {
  let app: INestApplication;
  const lecture = {
    reglagesEtCategories: jest.fn(async () => ({ categories: [], bareme: { FAIBLE: 1000, MOYENNE: 2000, HAUTE: 3000 }, validite_jours: 30, bon_restaurant: true })),
    compteurs: jest.fn(async () => ({ ouverts: 1, en_cours: 0, resolus: 0, en_retard: 0 })),
    tableau: jest.fn(async () => ({ colonnes: {} })),
    statistiques: jest.fn(async () => ({ total: 0 })),
    exporter: jest.fn(async () => ({ nom: 'incidents.csv', type: 'text/csv; charset=utf-8', contenu: Buffer.from('﻿"Incident"') })),
    agents: jest.fn(async () => [{ id: 'u-cc', fullname: 'Ruth Fetai', role: 'CALL_CENTER' }]),
    chercherCommandes: jest.fn(async () => []),
    parCommande: jest.fn(async () => ({ commande: {}, incidents: [], peut_signaler: true })),
    ouverts: jest.fn(async () => []),
    liste: jest.fn(async () => ({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } })),
    fiche: jest.fn(async () => ({ id: 'fiche' })),
  };
  const traitement = {
    signaler: jest.fn(async () => ({ id: 'nouveau' })),
    assigner: jest.fn(async () => ({ id: 'fiche' })),
    resoudre: jest.fn(async () => ({ id: 'fiche' })),
    cloturer: jest.fn(async () => ({ id: 'fiche' })),
    rouvrir: jest.fn(async () => ({ id: 'fiche' })),
    noter: jest.fn(async () => ({ id: 'fiche' })),
    creerBon: jest.fn(async () => ({ id: 'fiche' })),
    renvoyerSms: jest.fn(async () => ({ id: 'fiche' })),
  };
  const reglages = {
    enregistrer: jest.fn(async () => ({})),
    creerCategorie: jest.fn(async () => ({ id: 'cat' })),
    modifierCategorie: jest.fn(async () => ({ id: 'cat' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IncidentController],
      providers: [
        { provide: IncidentService, useValue: lecture },
        { provide: IncidentTraitementService, useValue: traitement },
        { provide: IncidentReglagesService, useValue: reglages },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(CompteConnecte)
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

  beforeEach(() => {
    role = UserRole.CALL_CENTER;
    jest.clearAllMocks();
  });

  const http = () => request(app.getHttpServer());

  it('les chemins fixes ne sont pas lus comme un identifiant d’incident', async () => {
    await http().get('/incidents/compteurs').expect(200, { ouverts: 1, en_cours: 0, resolus: 0, en_retard: 0 });
    await http().get('/incidents/tableau').expect(200);
    await http().get('/incidents/statistiques').expect(200);
    await http().get('/incidents/agents').expect(200);
    await http().get('/incidents/ouverts').expect(200);
    await http().get('/incidents/reglages').expect(200);
    await http().get('/incidents/commandes?recherche=50950').expect(200);
    await http().get(`/incidents/commande/${UUID}`).expect(200);
    const csv = await http().get('/incidents/export').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="incidents.csv"');
    expect(lecture.fiche).not.toHaveBeenCalled();
  });

  it('un identifiant qui n’est pas un uuid : 400, jamais la fiche', async () => {
    await http().get('/incidents/pas-un-uuid').expect(400);
    await http().post('/incidents/pas-un-uuid/resoudre').send({}).expect(400);
    expect(lecture.fiche).not.toHaveBeenCalled();
    await http().get(`/incidents/${UUID}`).expect(200, { id: 'fiche' });
  });

  it('les filtres passent typés, les filtres vides sont retirés, la page est bornée', async () => {
    await http().get('/incidents?page=2&limit=50&statut=RESOLU&restaurantId=&recherche=%20kon%C3%A9%20').expect(200);
    expect(lecture.liste).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 50, statut: 'RESOLU', recherche: 'koné' }),
      expect.objectContaining({ role: 'CALL_CENTER' }),
    );
    expect((lecture.liste.mock.calls[0] as unknown[])[0]).not.toHaveProperty('restaurantId', '');
    await http().get('/incidents?limit=500').expect(400);
    await http().get('/incidents?statut=PERDU').expect(400);
    await http().get('/incidents?du=11/11/2026').expect(400);
  });

  it('signaler : le corps est validé, avec des messages en français', async () => {
    const corps = { order_id: UUID, categorie_id: UUID, gravite: 'HAUTE', origine: 'APPEL', description: '  Poulet tiède  ' };
    await http().post('/incidents').send(corps).expect(201, { id: 'nouveau' });
    expect(traitement.signaler).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Poulet tiède', gravite: 'HAUTE' }),
      expect.objectContaining({ id: 'u-CALL_CENTER' }),
    );
    const refus = await http().post('/incidents').send({ ...corps, gravite: 'ENORME', order_id: 'x' }).expect(400);
    expect(refus.body.message).toEqual(expect.arrayContaining(['Choisissez la gravité.', 'Commande introuvable.']));
    // Un champ inconnu est retiré, pas transmis au service.
    await http().post('/incidents').send({ ...corps, statut: 'CLOTURE' }).expect(201);
    expect((traitement.signaler.mock.calls.at(-1) as unknown[])[0]).not.toHaveProperty('statut');
  });

  it('chaque geste exige le statut lu', async () => {
    await http().post(`/incidents/${UUID}/assigner`).send({}).expect(400);
    await http().post(`/incidents/${UUID}/assigner`).send({ statut_lu: 'OUVERT' }).expect(200);
    await http().post(`/incidents/${UUID}/assigner`).send({ statut_lu: 'OUVERT', agent_id: null }).expect(200);
    expect((traitement.assigner.mock.calls.at(-1) as unknown[])[1]).toMatchObject({ agent_id: null });
    await http().post(`/incidents/${UUID}/assigner`).send({ statut_lu: 'OUVERT', agent_id: 'x' }).expect(400);
    await http()
      .post(`/incidents/${UUID}/resoudre`)
      .send({ statut_lu: 'EN_COURS', cause: 'Oubli', action: 'Liste de contrôle', geste: 'BON', bon_montant: '2000' })
      .expect(200);
    expect((traitement.resoudre.mock.calls[0] as unknown[])[1]).toMatchObject({ bon_montant: 2000, geste: 'BON' });
    await http().post(`/incidents/${UUID}/resoudre`).send({ statut_lu: 'EN_COURS', cause: 'a', action: 'b', geste: 'CADEAU' }).expect(400);
    await http().post(`/incidents/${UUID}/cloturer`).send({ statut_lu: 'RESOLU', recontact: 'INFORME', reaction: 'Content' }).expect(200);
    await http().post(`/incidents/${UUID}/cloturer`).send({ statut_lu: 'RESOLU' }).expect(400);
    await http().post(`/incidents/${UUID}/rouvrir`).send({ statut_lu: 'CLOTURE', motif: 'Le client a rappelé' }).expect(200);
    await http().post(`/incidents/${UUID}/notes`).send({ note: 'x'.repeat(2001) }).expect(400);
    await http().post(`/incidents/${UUID}/notes`).send({ note: ' Vu ' }).expect(200);
    expect((traitement.noter.mock.calls[0] as unknown[])[1]).toEqual({ note: 'Vu' });
  });

  it('les rôles : qui lit, qui signale, qui traite, qui règle', async () => {
    const corps = { order_id: UUID, categorie_id: UUID, gravite: 'HAUTE', origine: 'APPEL', description: 'Poulet tiède' };

    role = UserRole.COMPTABLE;
    await http().get('/incidents/tableau').expect(403);
    await http().get(`/incidents/${UUID}`).expect(403);

    role = UserRole.MARKETING;
    await http().get('/incidents/tableau').expect(200);
    await http().get('/incidents/export').expect(403);
    await http().post('/incidents').send(corps).expect(403);
    await http().post(`/incidents/${UUID}/notes`).send({ note: 'x' }).expect(403);

    role = UserRole.CAISSIER;
    await http().post('/incidents').send(corps).expect(201);
    await http().post(`/incidents/${UUID}/notes`).send({ note: 'x' }).expect(200);
    await http().post(`/incidents/${UUID}/resoudre`).send({ statut_lu: 'OUVERT', cause: 'abc', action: 'def', geste: 'EXCUSES' }).expect(403);
    await http().get('/incidents/agents').expect(403);

    role = UserRole.MANAGER;
    await http().post(`/incidents/${UUID}/resoudre`).send({ statut_lu: 'OUVERT', cause: 'abc', action: 'def', geste: 'EXCUSES' }).expect(200);
    await http().post(`/incidents/${UUID}/rouvrir`).send({ statut_lu: 'CLOTURE', motif: 'abc' }).expect(403);
    await http().put('/incidents/reglages').send({ validite_jours: 10 }).expect(403);
    await http().post('/incidents/categories').send({ nom: 'Emballage', pole: 'RESTAURANT', delai_heures: 24 }).expect(403);

    role = UserRole.CALL_CENTER;
    await http().post(`/incidents/${UUID}/rouvrir`).send({ statut_lu: 'CLOTURE', motif: 'abc' }).expect(200);
    await http().put('/incidents/reglages').send({ validite_jours: 10 }).expect(403);

    role = UserRole.ADMIN;
    await http().put('/incidents/reglages').send({ bareme: { FAIBLE: '500', MOYENNE: 1500, HAUTE: 2500 }, bon_restaurant: false }).expect(200);
    expect((reglages.enregistrer.mock.calls[0] as unknown[])[0]).toMatchObject({
      bareme: { FAIBLE: 500, MOYENNE: 1500, HAUTE: 2500 },
      bon_restaurant: false,
    });
    await http().put('/incidents/reglages').send({ bareme: { FAIBLE: 'abc', MOYENNE: 1500, HAUTE: 2500 } }).expect(400);
    await http().post('/incidents/categories').send({ nom: 'Emballage', pole: 'RESTAURANT', delai_heures: 24 }).expect(201);
    await http().patch(`/incidents/categories/${UUID}`).send({ actif: false }).expect(200);
  });
});
