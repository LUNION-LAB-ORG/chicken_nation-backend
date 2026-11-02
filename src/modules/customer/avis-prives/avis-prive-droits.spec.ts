/**
 * Droits des retours privés, de bout en bout par HTTP (contrat 4.3).
 *
 * Le vrai contrôleur, les vraies gardes de droits, de rôles et de périmètre
 * restaurant, le vrai routage, le vrai masquage global des coordonnées et la
 * vraie lecture de la fiche (sur une base simulée). Seule l'authentification
 * est simulée : l'en-tête `x-role` fait le compte connecté, `x-restaurant`
 * son restaurant.
 */
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AvisCanal, AvisRessenti, AvisStatut, Prisma, UserRole } from '@prisma/client';
import * as request from 'supertest';
import { MasquerContactsInterceptor } from 'src/common/securite/masquer-contacts.interceptor';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { resolveStaffType } from 'src/modules/users/helpers/staff-type.helper';
import { creerBaseAvis } from './avis-prive-base-simulee-spec';
import { AvisPriveCleSiteGuard, ENTETE_CLE_SITE } from './avis-prive-cle-site.guard';
import { AvisPriveDepotService } from './avis-prive-depot.service';
import { AvisPriveThrottlerGuard } from './avis-prive-throttler.guard';
import { AvisPriveTraitementService } from './avis-prive-traitement.service';
import { AvisPriveController } from './avis-prive.controller';
import { AvisPriveService } from './avis-prive.service';

const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AVIS_A = '11111111-1111-4111-8111-11111111111a';
const AVIS_B = '11111111-1111-4111-8111-11111111111b';
const AVIS_SANS_STORE = '11111111-1111-4111-8111-11111111111c';
const CLIENT = 'c0000000-0000-4000-8000-000000000001';
const COMMANDE = 'd0000000-0000-4000-8000-000000000001';
const CLE = 'cle-du-site-pour-les-tests-0123456789abcdef';
const CLE_AVANT = process.env.CLE_SERVEUR_SITE;
beforeAll(() => {
  process.env.CLE_SERVEUR_SITE = CLE;
});
afterAll(() => {
  if (CLE_AVANT === undefined) delete process.env.CLE_SERVEUR_SITE;
  else process.env.CLE_SERVEUR_SITE = CLE_AVANT;
});

class AuthentificationSimulee implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-role'] as UserRole;
    const restaurant_id = (req.headers['x-restaurant'] as string | undefined) ?? null;
    req.user = { id: `u-${role}`, fullname: role, role, type: resolveStaffType(role), restaurant_id, entity_status: 'ACTIVE' };
    return true;
  }
}

const avis = (id: string, restaurant_id: string | null) => ({
  id,
  ressenti: AvisRessenti.PAS_CONTENT,
  canal: AvisCanal.TELEPHONE,
  restaurant_id,
  commentaire: 'Frites froides.',
  telephone: '+2250707000001',
  prenom: 'Awa',
  accord_rappel: true,
  statut: AvisStatut.A_RAPPELER,
  customer_id: CLIENT,
  created_at: new Date('2026-11-02T08:42:00.000Z'),
});

const ID = AVIS_A;
type Verbe = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const TRAITEMENT: [Verbe, string, object][] = [
  ['POST', `/avis-prives/${ID}/journal`, { action: 'NOTE', note: 'Rappeler ce soir.' }],
  ['PATCH', `/avis-prives/${ID}/statut`, { statut: 'EN_COURS', statut_lu: 'A_RAPPELER' }],
  ['PATCH', `/avis-prives/${ID}/commande`, { order_id: null, order_id_lu: COMMANDE }],
  ['PATCH', `/avis-prives/${ID}/agent`, { agent_id: null, agent_lu: null }],
  ['POST', `/avis-prives/${ID}/ticket`, { categoryId: '22222222-2222-4222-8222-222222222222', order_id: COMMANDE }],
  ['GET', '/avis-prives/agents', {}],
];

const SIEGE_TRAITE = [UserRole.ADMIN, UserRole.CALL_CENTER];
const LECTEURS = [UserRole.ADMIN, UserRole.CALL_CENTER, UserRole.MARKETING, UserRole.MANAGER, UserRole.CAISSIER];
const SANS_AVIS = [UserRole.ASSISTANT_MANAGER, UserRole.COMPTABLE, UserRole.LIVRAISON_OPS, UserRole.CUISINE];

describe('AvisPriveController : gardes posées', () => {
  const gardes = (nom: keyof AvisPriveController) =>
    Reflect.getMetadata(GUARDS_METADATA, AvisPriveController.prototype[nom]) as unknown[];

  it('envoi public : sans garde JWT, clé du site d’abord, puis la limite par IP (5 envois en 15 minutes)', () => {
    expect(gardes('envoyer')).toEqual([AvisPriveCleSiteGuard, AvisPriveThrottlerGuard]);
    expect(gardes('envoyer')).not.toContain(JwtAuthGuard);
    const handler = AvisPriveController.prototype.envoyer;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(15 * 60_000);
  });

  it('toutes les autres routes exigent un compte du personnel', () => {
    const autres = Object.getOwnPropertyNames(AvisPriveController.prototype).filter(
      (n) => n !== 'constructor' && n !== 'envoyer',
    ) as (keyof AvisPriveController)[];
    expect(autres.length).toBe(11);
    for (const nom of autres) expect(gardes(nom)).toContain(JwtAuthGuard);
  });
});

describe('AvisPriveController par HTTP : droits par rôle', () => {
  let app: INestApplication;
  const base = creerBaseAvis({
    avis: [avis(AVIS_A, RESTO_A), avis(AVIS_B, RESTO_B), avis(AVIS_SANS_STORE, null)],
    restaurants: [
      { id: RESTO_A, name: 'Yopougon' },
      { id: RESTO_B, name: 'Cocody' },
    ],
    customers: [{ id: CLIENT, phone: '+2250707000001', first_name: 'Awa', last_name: 'Koné', entity_status: 'ACTIVE' }],
    orders: [
      {
        id: 'o-1',
        reference: 'CN-A1B2',
        customer_id: CLIENT,
        restaurant_id: RESTO_A,
        entity_status: 'ACTIVE',
        created_at: new Date('2026-11-01T20:05:00.000Z'),
        restaurant: { id: RESTO_A, name: 'Yopougon' },
        channel: 'CALL_CENTER',
        auto: false,
        status: 'COMPLETED',
        type: 'DELIVERY',
        amount: 12000,
        order_items: [{ dish: { name: 'Box Champion' } }],
      },
    ],
  });
  const lecture = new AvisPriveService(base.prisma as never);
  const liste = jest.spyOn(lecture, 'liste').mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });
  const compteurs = jest
    .spyOn(lecture, 'compteurs')
    .mockResolvedValue({ nouveaux: 0, a_rappeler: 0, echeance_depassee: 0, resolus_7j: 0, a_traiter: 0 });
  const exporter = jest
    .spyOn(lecture, 'exporter')
    .mockResolvedValue({ nom: 'avis-prives-2026-11-02.csv', type: 'text/csv; charset=utf-8', contenu: Buffer.from('') });
  jest.spyOn(lecture, 'agents').mockResolvedValue([]);
  const traitement = {
    journal: jest.fn(async () => ({})),
    statut: jest.fn(async () => ({})),
    commande: jest.fn(async () => ({})),
    agent: jest.fn(async () => ({})),
    ticket: jest.fn(async () => ({})),
    supprimer: jest.fn(async () => undefined),
  };
  const depot = { deposer: jest.fn(async () => ({ ok: true })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
      controllers: [AvisPriveController],
      providers: [
        { provide: AvisPriveService, useValue: lecture },
        { provide: AvisPriveTraitementService, useValue: traitement },
        { provide: AvisPriveDepotService, useValue: depot },
        { provide: APP_INTERCEPTOR, useFactory: (r: Reflector) => new MasquerContactsInterceptor(r), inject: [Reflector] },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(AuthentificationSimulee)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  const appel = (role: UserRole | null, verbe: Verbe, chemin: string, corps: object = {}, restaurant?: string) => {
    const r = request(app.getHttpServer());
    const req =
      verbe === 'GET' ? r.get(chemin) : verbe === 'POST' ? r.post(chemin) : verbe === 'PATCH' ? r.patch(chemin) : r.delete(chemin);
    if (role) req.set('x-role', role);
    if (restaurant) req.set('x-restaurant', restaurant);
    return req.send(corps);
  };
  const restoDe = (role: UserRole) => (role === UserRole.MANAGER || role === UserRole.CAISSIER ? RESTO_A : undefined);

  it('envoi public : répond sans jeton au serveur du site', async () => {
    await appel(null, 'POST', '/avis-prives', {
      ressenti: 'AU_TOP',
      canal: 'APPLI',
      commentaire: 'Très bon poulet.',
      telephone: '0707000001',
    })
      .set(ENTETE_CLE_SITE, CLE)
      .expect(201, { ok: true });
    expect(depot.deposer).toHaveBeenCalled();
  });

  it('recherche : la liste et l’export reçoivent le compte qui lit (son rôle ferme la recherche par numéro au marketing)', async () => {
    liste.mockClear();
    exporter.mockClear();
    await appel(UserRole.MARKETING, 'GET', '/avis-prives?periode=tout&recherche=0001').expect(200);
    expect(liste.mock.calls[0][0]).toMatchObject({ recherche: '0001' });
    expect(liste.mock.calls[0][1]).toMatchObject({ role: UserRole.MARKETING });
    await appel(UserRole.CALL_CENTER, 'GET', '/avis-prives/export?recherche=0001').expect(200);
    expect(exporter.mock.calls[0][1]).toMatchObject({ role: UserRole.CALL_CENTER });
  });

  it.each(LECTEURS)('%s lit la liste, les compteurs et une fiche de son périmètre', async (role) => {
    await appel(role, 'GET', '/avis-prives', {}, restoDe(role)).expect(200);
    await appel(role, 'GET', '/avis-prives/compteurs', {}, restoDe(role)).expect(200);
    await appel(role, 'GET', `/avis-prives/${AVIS_A}`, {}, restoDe(role)).expect(200);
  });

  it.each(SANS_AVIS)('%s ne voit pas les avis : 403', async (role) => {
    const resto = role === UserRole.COMPTABLE || role === UserRole.LIVRAISON_OPS ? undefined : RESTO_A;
    await appel(role, 'GET', '/avis-prives', {}, resto).expect(403);
    await appel(role, 'GET', `/avis-prives/${AVIS_A}`, {}, resto).expect(403);
  });

  it('export : droit EXPORT (administrateur, call center, caissier), pas le marketing ni le manager', async () => {
    for (const role of [UserRole.ADMIN, UserRole.CALL_CENTER, UserRole.CAISSIER]) {
      await appel(role, 'GET', '/avis-prives/export', {}, restoDe(role)).expect(200);
    }
    for (const role of [UserRole.MARKETING, UserRole.MANAGER]) {
      await appel(role, 'GET', '/avis-prives/export', {}, restoDe(role)).expect(403);
    }
  });

  it('suppression : administrateur seul', async () => {
    await appel(UserRole.ADMIN, 'DELETE', `/avis-prives/${ID}`).expect(204);
    for (const role of [UserRole.CALL_CENTER, UserRole.MARKETING, UserRole.MANAGER, UserRole.CAISSIER]) {
      await appel(role, 'DELETE', `/avis-prives/${ID}`, {}, restoDe(role)).expect(403);
    }
    expect(traitement.supprimer).toHaveBeenCalledTimes(1);
  });

  it.each(TRAITEMENT)('%s %s : administrateur et call center seulement', async (verbe, chemin, corps) => {
    for (const role of SIEGE_TRAITE) {
      const res = await appel(role, verbe, chemin, corps);
      expect([200, 201]).toContain(res.status);
    }
    for (const role of [UserRole.MARKETING, UserRole.MANAGER, UserRole.CAISSIER]) {
      await appel(role, verbe, chemin, corps, restoDe(role)).expect(403);
    }
  });

  it('manager et caissier forcés sur leur restaurant, même en demandant un autre ou « Je ne sais pas »', async () => {
    liste.mockClear();
    compteurs.mockClear();
    exporter.mockClear();
    await appel(UserRole.MANAGER, 'GET', `/avis-prives?restaurantId=${RESTO_B}`, {}, RESTO_A).expect(200);
    await appel(UserRole.MANAGER, 'GET', '/avis-prives?restaurantId=aucun', {}, RESTO_A).expect(200);
    await appel(UserRole.MANAGER, 'GET', '/avis-prives', {}, RESTO_A).expect(200);
    await appel(UserRole.MANAGER, 'GET', `/avis-prives/compteurs?restaurantId=${RESTO_B}`, {}, RESTO_A).expect(200);
    await appel(UserRole.CAISSIER, 'GET', '/avis-prives/export?restaurantId=aucun', {}, RESTO_A).expect(200);
    for (const [q] of liste.mock.calls) expect(q.restaurantId).toBe(RESTO_A);
    expect(compteurs.mock.calls[0][0]).toBe(RESTO_A);
    expect(exporter.mock.calls[0][0].restaurantId).toBe(RESTO_A);
  });

  it('siège : filtre Store libre, « aucun » compris', async () => {
    liste.mockClear();
    await appel(UserRole.CALL_CENTER, 'GET', '/avis-prives?restaurantId=aucun&periode=tout').expect(200);
    expect(liste.mock.calls[0][0]).toMatchObject({ restaurantId: 'aucun', periode: 'tout' });
  });

  it('fiche d’un autre restaurant, ou sans store : 403 pour un point de vente', async () => {
    for (const role of [UserRole.MANAGER, UserRole.CAISSIER]) {
      await appel(role, 'GET', `/avis-prives/${AVIS_B}`, {}, RESTO_A).expect(403);
      await appel(role, 'GET', `/avis-prives/${AVIS_SANS_STORE}`, {}, RESTO_A).expect(403);
    }
    await appel(UserRole.CALL_CENTER, 'GET', `/avis-prives/${AVIS_SANS_STORE}`).expect(200);
  });

  it('dernières commandes : null pour le marketing, la liste pour le call center et le manager', async () => {
    const marketing = await appel(UserRole.MARKETING, 'GET', `/avis-prives/${AVIS_A}`).expect(200);
    expect(marketing.body.dernieres_commandes).toBeNull();
    const centre = await appel(UserRole.CALL_CENTER, 'GET', `/avis-prives/${AVIS_A}`).expect(200);
    expect(centre.body.dernieres_commandes).toEqual([
      expect.objectContaining({ reference: 'CN-A1B2', channel: 'CALL_CENTER', amount: 12000, plats: ['Box Champion'] }),
    ]);
    const manager = await appel(UserRole.MANAGER, 'GET', `/avis-prives/${AVIS_A}`, {}, RESTO_A).expect(200);
    expect(manager.body.dernieres_commandes).toHaveLength(1);
  });

  it('numéros masqués pour le marketing (avis et compte client), en clair pour le call center', async () => {
    const marketing = await appel(UserRole.MARKETING, 'GET', `/avis-prives/${AVIS_A}`).expect(200);
    expect(marketing.body.telephone).toBe('+225••••••••01');
    expect(marketing.body.client.telephone).toBe('+225••••••••01');
    expect(JSON.stringify(marketing.body)).not.toContain('0707000001');
    const centre = await appel(UserRole.CALL_CENTER, 'GET', `/avis-prives/${AVIS_A}`).expect(200);
    expect(centre.body.telephone).toBe('+2250707000001');
    expect(centre.body.client.telephone).toBe('+2250707000001');
  });
});

describe('recherche par chiffres et numéros masqués', () => {
  const MAINTENANT = new Date('2026-11-02T10:00:00.000Z');

  /** Requêtes SQL de la liste, pour un lecteur et une recherche. */
  async function requetesListe(role: UserRole, recherche?: string): Promise<Prisma.Sql[]> {
    const requetes: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (morceaux: TemplateStringsArray, ...valeurs: unknown[]) => {
        requetes.push(Prisma.sql(morceaux, ...(valeurs as Prisma.Sql[])));
        return [];
      }),
      avisPrive: { findMany: jest.fn(async () => []) },
    };
    await new AvisPriveService(prisma as never).liste({ periode: 'tout', recherche }, { role }, MAINTENANT);
    return requetes;
  }
  const memes = (a: Prisma.Sql[], b: Prisma.Sql[]) =>
    expect(a.map((r) => [r.sql, r.values])).toEqual(b.map((r) => [r.sql, r.values]));

  it('marketing : « 0001 » donne exactement la liste sans recherche (rien à deviner du numéro masqué)', async () => {
    const sans = await requetesListe(UserRole.MARKETING);
    for (const motif of ['0001', '0101', '07 07 00 00 01', '+2250707000001']) {
      memes(await requetesListe(UserRole.MARKETING, motif), sans);
    }
  });

  it('call center : la recherche par chiffres porte bien sur le numéro', async () => {
    const [compte] = await requetesListe(UserRole.CALL_CENTER, '0001');
    expect(compte.sql).toContain("regexp_replace(coalesce(a.telephone, ''), '[^0-9]', '', 'g') LIKE");
    expect(compte.values).toContain('%0001%');
  });

  it('marketing : la recherche par mot reste possible (prénom, commentaire)', async () => {
    const [compte] = await requetesListe(UserRole.MARKETING, 'frites');
    expect(compte.sql).toContain('a.commentaire ILIKE');
    expect(compte.sql).not.toContain('a.telephone');
  });
});
