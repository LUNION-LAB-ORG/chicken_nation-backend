import { EntityStatus, Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function categorySeed() {
    const categoriesData: Prisma.CategoryCreateInput[] = [
      {
        name: 'Poulets Frits',
        description: 'Nos délicieux poulets frits croustillants',
        entity_status: EntityStatus.ACTIVE,
      },
      {
        name: 'Burger',
        description: 'Burgers gourmets avec viande 100% boeuf',
        entity_status: EntityStatus.ACTIVE,
      },
      {
        name: 'Accompagnements',
        description: 'Les parfaits accompagnements pour vos plats',
        entity_status: EntityStatus.ACTIVE,
      },
      {
        name: 'Boissons',
        description: 'Rafraîchissements et boissons gazeuses',
        entity_status: EntityStatus.ACTIVE,
      },
    ];
  
    for (const categoryData of categoriesData) {
      await prisma.category.upsert({
        where: { name: categoryData.name },
        update: categoryData,
        create: categoryData,
      });
    }
  }
