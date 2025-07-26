import { Prisma, PrismaClient, SupplementCategory } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function supplementSeed() {
  const supplementsData: Prisma.SupplementCreateInput[] = [
    {
      name: 'Sauce BBQ',
      price: 300,
      category: SupplementCategory.FOOD,
      available: true,
    },
    {
      name: 'Sauce Mayonnaise',
      price: 300,
      category: SupplementCategory.FOOD,
      available: true,
    },
    {
      name: 'Coca-Cola Zéro',
      price: 500,
      category: SupplementCategory.DRINK,
      available: true,
    },
  ];

  for (const supplementData of supplementsData) {
    await prisma.supplement.upsert({
      where: { name: supplementData.name },
      update: supplementData,
      create: supplementData,
    });
  }
}
