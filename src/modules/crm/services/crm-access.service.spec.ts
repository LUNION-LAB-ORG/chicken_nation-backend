import { ForbiddenException } from '@nestjs/common';
import { EntityStatus, User, UserRole as R, UserType as T } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { COMMANDE_EFFECTIVE_SQL, ficheDuRestaurant, ficheDuRestaurantSql } from '../crm.rules';
import { CrmAccessService } from './crm-access.service';
import { filtreRestaurant } from './crm-passages.query';

/** Les règles de portée ne lisent pas la base : un faux PrismaService suffit. */
const access = new CrmAccessService({} as PrismaService);

const RESTAURANT = '11111111-1111-4111-8111-111111111111';
/** Id impossible posé par `resolveRestaurantScope` pour un point de vente sans restaurant. */
const SENTINELLE = '00000000-0000-0000-0000-000000000000';

const compte = (role: R, partiel: Partial<User> = {}) =>
  ({ id: `u-${role}`, role, type: T.BACKOFFICE, restaurant_id: null, ...partiel }) as User;

const admin = compte(R.ADMIN);
const marketing = compte(R.MARKETING);
const callCenter = compte(R.CALL_CENTER);
const manager = compte(R.MANAGER, { type: T.RESTAURANT, restaurant_id: RESTAURANT });
const managerSansRestaurant = compte(R.MANAGER, { type: T.RESTAURANT, restaurant_id: null });

describe('estLecteur', () => {
  it('lit sans UPDATE ni CREATE : marketing et manager', () => {
    expect(access.estLecteur(marketing)).toBe(true);
    expect(access.estLecteur(manager)).toBe(true);
  });

  it("ni la direction (CREATE), ni l'agent (UPDATE), ni un rôle sans CRM", () => {
    expect(access.estLecteur(admin)).toBe(false);
    expect(access.estLecteur(callCenter)).toBe(false);
    expect(access.estLecteur(compte(R.CAISSIER))).toBe(false);
    expect(access.estLecteur(compte(R.COMPTABLE))).toBe(false);
  });

  it('un lecteur ne reçoit jamais de contacts à traiter', () => {
    expect(access.rolesAgents()).toContain(R.CALL_CENTER);
    expect(access.rolesAgents()).not.toContain(R.MARKETING);
    expect(access.rolesAgents()).not.toContain(R.MANAGER);
  });
});

describe('portee', () => {
  it('direction : tout', () => {
    expect(access.portee(admin)).toEqual({});
  });

  it('agent : ses contacts, ceux de ses campagnes et la file commune', () => {
    const p = access.portee(callCenter);
    expect(p.OR).toHaveLength(3);
    expect(p.OR?.[0]).toEqual({ assigned_to_id: callCenter.id });
    expect(p.OR?.[1]).toEqual({ campaign: { lead_agent_id: callCenter.id } });
    expect(p.OR?.[2]).toMatchObject({ assigned_to_id: null, campaign_id: null });
  });

  it('lecteur du siège : tout, sans restriction', () => {
    expect(access.portee(marketing)).toEqual({});
  });

  it('lecteur de point de vente : les seules fiches de son restaurant', () => {
    expect(access.portee(manager)).toEqual({ AND: [{}, ficheDuRestaurant(RESTAURANT)] });
  });

  it('point de vente sans restaurant rattaché : un id qui n’existe pas, donc aucune fiche', () => {
    expect(access.portee(managerSansRestaurant)).toEqual({ AND: [{}, ficheDuRestaurant(SENTINELLE)] });
  });

  it('le restaurant vient du compte, pas du type de rôle : un compte du siège n’est pas cloisonné', () => {
    expect(access.portee(compte(R.MANAGER, { restaurant_id: RESTAURANT }))).toEqual({});
  });

  it('sans droit de lecture du CRM : refus', () => {
    expect(() => access.portee(compte(R.COMPTABLE))).toThrow(ForbiddenException);
  });
});

describe('ficheDuRestaurant', () => {
  it('capture non supprimée au restaurant, ou commande qui compte au restaurant', () => {
    expect(ficheDuRestaurant(RESTAURANT)).toEqual({
      OR: [
        { captures: { some: { restaurant_id: RESTAURANT, entity_status: { not: EntityStatus.DELETED } } } },
        {
          customer: {
            orders: {
              some: {
                restaurant_id: RESTAURANT,
                entity_status: { not: EntityStatus.DELETED },
                NOT: { payment_method: 'ONLINE', paied: false, status: 'PENDING' },
              },
            },
          },
        },
      ],
    });
  });
});

describe('ficheDuRestaurantSql', () => {
  const sql = ficheDuRestaurantSql('k.contact_id', RESTAURANT);
  const texte = sql.sql.replace(/\s+/g, ' ');

  it('porte sur la colonne donnée, en une sous-requête sans lien avec la ligne', () => {
    expect(texte.startsWith('k.contact_id IN ( SELECT rcap."contact_id" FROM "Prospect" rcap')).toBe(true);
    expect(texte).toContain('UNION');
    // La colonne n'apparaît qu'une fois, devant IN : rien ne relie la sous-requête à la ligne.
    expect(texte.replace('k.contact_id', '')).not.toContain('k.');
  });

  it('les mêmes règles que la condition Prisma : capture non supprimée, commande qui compte', () => {
    expect(texte).toContain(`rcap."contact_id" IS NOT NULL AND rcap."entity_status" <> 'DELETED' AND rcap."restaurant_id" = ?::uuid`);
    expect(texte).toContain('JOIN "Order" o ON o."customer_id" = rx."customer_id"');
    expect(texte).toContain(`o."restaurant_id" = ?::uuid AND ${COMMANDE_EFFECTIVE_SQL.replace(/\s+/g, ' ')}`);
  });

  it('le restaurant est un paramètre, jamais collé dans le texte', () => {
    expect(sql.values).toEqual([RESTAURANT, RESTAURANT]);
    expect(sql.sql).not.toContain(RESTAURANT);
  });

  it('filtreRestaurant : rien pour le siège, la condition pour un point de vente', () => {
    expect(filtreRestaurant('x.id', {}).sql).toBe('');
    expect(filtreRestaurant('x.id', { perimetre_restaurant: undefined }).sql).toBe('');
    const f = filtreRestaurant('x.id', { perimetre_restaurant: RESTAURANT });
    expect(f.sql.startsWith('AND x.id IN (')).toBe(true);
    expect(f.values).toEqual([RESTAURANT, RESTAURANT]);
  });
});

describe('filtresAnalyse', () => {
  it('siège : filtres inchangés, sans périmètre', () => {
    expect(access.filtresAnalyse(marketing, { from: '2026-09-01', campaign_id: 'c1' })).toEqual({
      from: '2026-09-01',
      campaign_id: 'c1',
      perimetre_restaurant: undefined,
    });
  });

  it('point de vente : son restaurant, et le filtre de campagne ignoré', () => {
    expect(access.filtresAnalyse(manager, { from: '2026-09-01', campaign_id: 'c1' })).toEqual({
      from: '2026-09-01',
      campaign_id: undefined,
      perimetre_restaurant: RESTAURANT,
    });
  });

  it('un périmètre glissé dans la requête est toujours écrasé', () => {
    const q = { perimetre_restaurant: RESTAURANT } as { perimetre_restaurant?: string };
    expect(access.filtresAnalyse(admin, q).perimetre_restaurant).toBeUndefined();
    const autre = { perimetre_restaurant: '22222222-2222-4222-8222-222222222222' };
    expect(access.filtresAnalyse(manager, autre).perimetre_restaurant).toBe(RESTAURANT);
  });

  it('point de vente sans restaurant : la sentinelle', () => {
    expect(access.filtresAnalyse(managerSansRestaurant, {}).perimetre_restaurant).toBe(SENTINELLE);
  });
});

describe('assertSiege', () => {
  it('les campagnes se consultent au siège', () => {
    expect(() => access.assertSiege(manager)).toThrow('Les campagnes se consultent au siège');
    expect(() => access.assertSiege(managerSansRestaurant)).toThrow(ForbiddenException);
    expect(() => access.assertSiege(marketing)).not.toThrow();
    expect(() => access.assertSiege(admin)).not.toThrow();
  });
});

describe('assertDuRestaurant', () => {
  const avec = (nombre: number) => {
    const count = jest.fn().mockResolvedValue(nombre);
    return { service: new CrmAccessService({ crmContact: { count } } as unknown as PrismaService), count };
  };

  it("siège : aucune vérification, aucune requête", async () => {
    const { service, count } = avec(0);
    await expect(service.assertDuRestaurant(marketing, 'f1')).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it('point de vente : la fiche doit être de son restaurant', async () => {
    const { service, count } = avec(1);
    await expect(service.assertDuRestaurant(manager, 'f1')).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledWith({ where: { AND: [{ id: 'f1' }, ficheDuRestaurant(RESTAURANT)] } });
  });

  it("fiche d'un autre restaurant : 403 avec le message attendu", async () => {
    const { service } = avec(0);
    await expect(service.assertDuRestaurant(manager, 'f1')).rejects.toThrow(
      "Ce client n'est pas rattaché à votre restaurant",
    );
  });
});
