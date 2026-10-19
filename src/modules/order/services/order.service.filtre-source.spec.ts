/**
 * Filtre « source » (site, appli, téléphone) des trois lectures que le filtre
 * du backoffice alimente : la liste des commandes (écran Commandes et
 * Opérations), l'export Excel et le tableau des livraisons par restaurant.
 *
 * Demande du 19/10 : une option « Site web » à côté de « Par application » et
 * « Par téléphone ». La règle est testée dans canal-commande.rules.spec.ts ;
 * ici, le `where` réellement envoyé à Prisma est ÉVALUÉ comme en base (valeurs
 * nulles comprises) sur toutes les commandes possibles.
 *
 * Et sans `source`, rien ne change : un backoffice plus ancien qui envoie
 * seulement `auto` garde l'ancien résultat.
 *
 * Comme order.service.canal.spec.ts, les méthodes sont testées en isolation :
 * seules les dépendances qu'elles lisent sont greffées.
 */

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { EntityStatus, OrderChannel, OrderStatus, OrderType, Prisma, User, UserRole } from '@prisma/client';
import { QueryOrderDto } from '../dto/query-order.dto';
import { SourceCommande, sourceDeCommande } from '../helpers/canal-commande.rules';
import { rendueParLaBase } from '../helpers/where-sql.simule-spec';
import { OrderService } from './order.service';

type Commande = {
  id: string;
  channel: OrderChannel | null;
  auto: boolean;
  status: OrderStatus;
  type: OrderType;
  entity_status: EntityStatus;
  created_at: Date;
};

/** Toutes les combinaisons utiles : canal (vide compris) × auto × en attente ou non. */
const COMMANDES: Commande[] = [
  OrderChannel.APP,
  OrderChannel.WEB,
  OrderChannel.CALL_CENTER,
  OrderChannel.RESTAURANT,
  null,
].flatMap((channel) =>
  [true, false].flatMap((auto) =>
    [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.COMPLETED].map((status) => ({
      id: `${channel ?? 'sans-canal'}-${auto ? 'auto' : 'manuel'}-${status}`,
      channel,
      auto,
      status,
      type: OrderType.DELIVERY,
      entity_status: EntityStatus.ACTIVE,
      created_at: new Date(),
    })),
  ),
);

const compte = (role: UserRole) => ({ id: `u-${role}`, role }) as unknown as User;
const ADMIN = compte(UserRole.ADMIN);
const CAISSIER = compte(UserRole.CAISSIER);

function monter() {
  const lus: Prisma.OrderWhereInput[] = [];
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, {
    prisma: {
      order: {
        findMany: jest.fn(async ({ where }: { where: Prisma.OrderWhereInput }) => {
          lus.push(where);
          return [];
        }),
        count: jest.fn(async () => 0),
      },
    },
  });
  /** Identifiants des commandes que la base rendrait pour le dernier `where` lu. */
  const rendues = () => {
    const where = lus[lus.length - 1];
    return COMMANDES.filter((c) => rendueParLaBase(c, where)).map((c) => c.id).sort();
  };
  return { service, lus, rendues };
}

const ids = (filtre: (c: Commande) => boolean) => COMMANDES.filter(filtre).map((c) => c.id).sort();

const de = (source: SourceCommande) => (c: Commande) => sourceDeCommande(c) === source;
const pasEnAttente = (c: Commande) => c.status !== OrderStatus.PENDING;

const filtres = (f: Partial<QueryOrderDto>) => f as QueryOrderDto;

describe('GET /orders (liste, Opérations) : filtre « source »', () => {
  it('« Site web » : les commandes du site, sans les brouillons', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ source: 'site' }), ADMIN);
    expect(rendues()).toEqual(ids((c) => de('site')(c) && pasEnAttente(c)));
    expect(rendues().length).toBeGreaterThan(0);
  });

  it('« Par application » : sans le site, avec les anciennes commandes sans canal', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ source: 'appli' }), ADMIN);
    expect(rendues()).toEqual(ids((c) => de('appli')(c) && pasEnAttente(c)));
    expect(rendues()).toContain(`sans-canal-auto-${OrderStatus.ACCEPTED}`);
    expect(rendues()).not.toContain(`${OrderChannel.WEB}-auto-${OrderStatus.ACCEPTED}`);
  });

  it('« Par téléphone » : auto faux, commandes du site reprises au téléphone comprises', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ source: 'telephone' }), ADMIN);
    expect(rendues()).toEqual(ids((c) => !c.auto));
    expect(rendues()).toContain(`${OrderChannel.WEB}-manuel-${OrderStatus.ACCEPTED}`);
  });

  it('un rôle habilité qui demande « En attente » voit les brouillons du site', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ source: 'site', status: OrderStatus.PENDING }), ADMIN);
    expect(rendues()).toEqual([`${OrderChannel.WEB}-auto-${OrderStatus.PENDING}`]);
  });

  it('un rôle non habilité ne voit jamais de commande en attente', async () => {
    for (const source of ['site', 'appli', 'telephone'] as const) {
      const { service, rendues } = monter();
      await service.findAll(filtres({ source, status: OrderStatus.PENDING }), CAISSIER);
      expect(rendues()).toEqual([]);
      await service.findAll(filtres({ source }), CAISSIER);
      expect(rendues()).toEqual(ids((c) => de(source)(c) && pasEnAttente(c)));
    }
  });

  it('le filtre de statut de l’appelant est gardé', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ source: 'appli', status: OrderStatus.COMPLETED }), ADMIN);
    expect(rendues()).toEqual(ids((c) => de('appli')(c) && c.status === OrderStatus.COMPLETED));
  });

  it('`source` prime sur `auto` (le backoffice envoie les deux, pour un serveur plus ancien)', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ source: 'site', auto: true }), ADMIN);
    expect(rendues()).toEqual(ids((c) => de('site')(c) && pasEnAttente(c)));
  });

  it('sans `source`, le `where` historique est inchangé', async () => {
    const { service, lus } = monter();
    await service.findAll(filtres({ auto: true }), ADMIN);
    expect(lus[0]).toMatchObject({ auto: true, status: { not: OrderStatus.PENDING } });
    expect(lus[0].AND).toBeUndefined();

    await service.findAll(filtres({ auto: false }), ADMIN);
    expect(lus[1]).toMatchObject({ auto: false });
    expect(lus[1].AND).toBeUndefined();

    await service.findAll(filtres({}), ADMIN);
    expect(lus[2].OR).toEqual([
      { auto: false },
      { AND: [{ auto: true }, { status: { not: OrderStatus.PENDING } }] },
    ]);
    expect(lus[2].AND).toBeUndefined();
  });

  it('sans `source`, auto=true garde l’ancien résultat : site et application ensemble', async () => {
    const { service, rendues } = monter();
    await service.findAll(filtres({ auto: true }), ADMIN);
    expect(rendues()).toEqual(ids((c) => c.auto && pasEnAttente(c)));
  });
});

describe.each([
  ['GET /orders/export-report-to-excel', (s: OrderService, f: QueryOrderDto) => s.exportOrderReportToExcel(f)],
  ['GET /orders/export-delivery-pivot', (s: OrderService, f: QueryOrderDto) => s.exportDeliveryPivotToExcel(f)],
])('%s : filtre « source »', (_route, exporter) => {
  it.each(['site', 'appli', 'telephone'] as const)('%s : même règle que la liste, sans brouillon', async (source) => {
    const { service, rendues } = monter();
    await exporter(service, filtres({ source }));
    expect(rendues()).toEqual(ids((c) => de(source)(c) && (source === 'telephone' || pasEnAttente(c))));
  });

  it('le filtre de statut est gardé', async () => {
    const { service, rendues } = monter();
    await exporter(service, filtres({ source: 'site', status: OrderStatus.COMPLETED }));
    expect(rendues()).toEqual([`${OrderChannel.WEB}-auto-${OrderStatus.COMPLETED}`]);
  });

  it('sans `source`, le `where` historique est inchangé', async () => {
    const { service, lus } = monter();
    await exporter(service, filtres({ auto: true }));
    expect(lus[0]).toMatchObject({ auto: true, status: { not: OrderStatus.PENDING } });
    expect(lus[0].AND).toBeUndefined();

    await exporter(service, filtres({}));
    expect(lus[1].OR).toEqual([
      { auto: false },
      { AND: [{ auto: true }, { status: { not: OrderStatus.PENDING } }] },
    ]);
    expect(lus[1].AND).toBeUndefined();
  });
});

describe('QueryOrderDto : le paramètre `source`', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta: ArgumentMetadata = { type: 'query', metatype: QueryOrderDto };
  const lire = (query: Record<string, string>) => pipe.transform(query, meta) as Promise<QueryOrderDto>;

  it('accepte site, appli et telephone', async () => {
    for (const source of ['site', 'appli', 'telephone']) {
      expect((await lire({ source, auto: 'true' })).source).toBe(source);
    }
  });

  it('refuse une autre valeur', async () => {
    await expect(lire({ source: 'web' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vide ou absent : pas de filtre, `auto` lu comme avant', async () => {
    const vide = await lire({ source: '', auto: 'true' });
    expect(vide.source).toBeUndefined();
    expect(vide.auto).toBe(true);
    const absent = await lire({ auto: 'false' });
    expect(absent.source).toBeUndefined();
    expect(absent.auto).toBe(false);
  });
});
