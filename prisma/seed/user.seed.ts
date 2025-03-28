import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function userSeed() {
  const datas: Prisma.UserCreateInput[] = [
    {
      fullname: 'Admin Lunion',
      email: 'admin@lunion.com',
      password: 'admin',
      type: 'ADMIN',
      role: 'ADMIN',
    },
  ];

  for (const data of datas) {
    try {
      await prisma.user.upsert({
        where: { email: data.email },
        update: {
          ...data,
        },
        create: {
          ...data,
        },
      });
    } catch (error) {
      console.error(
        `Erreur lors de l'upsert de l'utilisateur ${data.email}:`,
        error,
      );
    }
  }
}
