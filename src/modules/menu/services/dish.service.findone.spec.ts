import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { DishService } from './dish.service';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const AUTRE_CLIENT = '22222222-2222-4222-8222-222222222222';

function monter(favori: { id: string } | null = null) {
  const prisma = {
    dish: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'd1',
        name: 'Burger',
        entity_status: EntityStatus.ACTIVE,
        category: null,
        option_groups: [],
      }),
    },
    favorite: { findFirst: jest.fn().mockResolvedValue(favori) },
    supplement: { findMany: jest.fn().mockResolvedValue([]) },
    restaurant: { findMany: jest.fn().mockResolvedValue([]) },
    dishExcludedSupplement: { findMany: jest.fn().mockResolvedValue([]) },
    dishExcludedRestaurant: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new DishService(prisma as unknown as PrismaService, {} as never, {} as never, {} as never);
  return { prisma, service };
}

describe('DishService.findOne (GET /dishes/:id, route publique)', () => {
  it('ne charge ni ne renvoie la liste des clients qui ont le plat en favori', async () => {
    const { prisma, service } = monter();

    const plat = await service.findOne('d1');

    expect(prisma.dish.findFirst.mock.calls[0][0].include.favorites).toBeUndefined();
    expect(plat).not.toHaveProperty('favorites');
    expect(plat.isFavorite).toBe(false);
    // Sans client demandé, aucune lecture des favoris.
    expect(prisma.favorite.findFirst).not.toHaveBeenCalled();
  });

  it('isFavorite ne lit que la ligne du client demandé', async () => {
    const { prisma, service } = monter({ id: 'f1' });

    const plat = await service.findOne('d1', CLIENT);

    expect(plat.isFavorite).toBe(true);
    expect(prisma.favorite.findFirst).toHaveBeenCalledWith({
      where: { dish_id: 'd1', customer_id: CLIENT },
      select: { id: true },
    });
    expect(JSON.stringify(plat)).not.toContain(AUTRE_CLIENT);
  });

  it("identifiant client mal formé : non, sans interroger la colonne UUID", async () => {
    const { prisma, service } = monter({ id: 'f1' });

    const plat = await service.findOne('d1', 'pas-un-uuid');

    expect(plat.isFavorite).toBe(false);
    expect(prisma.favorite.findFirst).not.toHaveBeenCalled();
  });
});
