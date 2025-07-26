import { EntityStatus, Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function dishSeed() {
  const restaurant = await prisma.restaurant.findFirst();
  const categories = await prisma.category.findMany();

  if (!restaurant || !categories.length) {
    throw new Error('Required data missing for dish seed');
  }

  const dishesData: Prisma.DishCreateInput[] = [
    {
      name: 'Poulet Frit Classique',
      description: '8 pièces de poulet frit avec 2 accompagnements',
      price: 8000,
      is_promotion: true,
      promotion_price: 7000,
      category: { connect: { id: categories[0].id } },
      entity_status: EntityStatus.ACTIVE,
      dish_restaurants: {
        create: { restaurant: { connect: { id: restaurant.id } } }
      }
    },
    {
      name: 'Burger Chicken Deluxe',
      description: 'Burger au poulet croustillant avec sauce spéciale',
      price: 5000,
      category: { connect: { id: categories[1].id } },
      entity_status: EntityStatus.ACTIVE,
      dish_restaurants: {
        create: { restaurant: { connect: { id: restaurant.id } } }
      }
    },
    {
      name: 'Frites Maison',
      description: 'Frites coupées maison avec peau',
      price: 1500,
      category: { connect: { id: categories[2].id } },
      entity_status: EntityStatus.ACTIVE,
      dish_restaurants: {
        create: { restaurant: { connect: { id: restaurant.id } } }
      }
    },
    {
      name: 'Coca-Cola 33cl',
      description: 'Canette de Coca-Cola bien fraîche',
      price: 1000,
      category: { connect: { id: categories[3].id } },
      entity_status: EntityStatus.ACTIVE,
      dish_restaurants: {
        create: { restaurant: { connect: { id: restaurant.id } } }
      }
    },
  ];

  for (const dishData of dishesData) {
    await prisma.dish.upsert({
      where: { name: dishData.name },
      update: dishData,
      create: dishData,
    });
  }
}
