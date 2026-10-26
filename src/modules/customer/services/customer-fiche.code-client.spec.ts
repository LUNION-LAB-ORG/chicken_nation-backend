/**
 * Fiche d'un client (`GET /customer/:id`, droit CLIENTS READ) : ses commandes
 * partent sans le code de retrait du client (`recovery_code`). La fiche est
 * ouverte au marketing, à la caisse et au gérant ; le code ne sort qu'à
 * l'administrateur et au call center (order/helpers/code-client.rules.ts).
 */
import { EntityStatus } from '@prisma/client';
import { CustomerService } from './customer.service';

const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function monter() {
  const findUnique = jest.fn(async () => ({ id: 'client-1', entity_status: EntityStatus.ACTIVE, orders: [] }));
  const service = new CustomerService({ customer: { findUnique } } as never, {} as never, {} as never);
  return { service, findUnique };
}

const argumentsLus = (findUnique: jest.Mock) => (findUnique.mock.calls[0] as any[])[0];

describe('GET /customer/:id : commandes du client sans le code de retrait', () => {
  it('le code n’est pas lu en base, pour le siège comme pour un restaurant', async () => {
    for (const restaurant of [undefined, RESTAURANT_A]) {
      const { service, findUnique } = monter();
      await service.findOne('client-1', restaurant);
      expect(argumentsLus(findUnique).include.orders.omit).toEqual({ recovery_code: true });
    }
  });

  it('le reste de la lecture des commandes ne change pas (filtre, restaurant, ordre)', async () => {
    const { service, findUnique } = monter();
    await service.findOne('client-1', RESTAURANT_A);
    const { omit: _omit, ...commandes } = argumentsLus(findUnique).include.orders;
    expect(commandes).toEqual({
      where: {
        OR: [{ AND: [{ paied: false }, { auto: false }] }, { paied: true }],
        entity_status: { not: EntityStatus.DELETED },
        restaurant_id: RESTAURANT_A,
      },
      orderBy: { created_at: 'desc' },
    });
  });
});
