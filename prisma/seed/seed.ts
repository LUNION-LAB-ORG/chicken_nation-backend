import { PrismaClient } from '@prisma/client';
import { userSeed } from './user.seed';
import { restaurantSeed } from './restaurant.seed';
import { categorySeed } from './category.seed';
import { dishSeed } from './dish.seed';
import { supplementSeed } from './supplement.seed';
import { loyaltyConfigSeed } from './loyalty-config.seed';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

async function main() {
  // user seed
  await userSeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  await restaurantSeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  await categorySeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  await dishSeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  await supplementSeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  await loyaltyConfigSeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// Run the seed
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => await prisma.$disconnect());
