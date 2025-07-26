import { PrismaClient } from '@prisma/client';
import { userSeed } from './user.seed';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

async function main() {
  // user seed
  await userSeed().catch((e) => {
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
