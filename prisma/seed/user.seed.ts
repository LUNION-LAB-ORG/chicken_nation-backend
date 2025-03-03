import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function userSeed() {
  const datas: Prisma.UserCreateInput[] = [
    {
      telephone: '+2250554020623',
      type: 'ADMINISTRATOR',
      is_super_admin: true,
    },
  ];

  for (const data of datas) {
    try {
      await prisma.user.upsert({
        where: { telephone: data.telephone },
        update: {
          ...data,
        },
        create: {
          ...data,
        },
      });
    } catch (error) {
      console.error(
        `Erreur lors de l'upsert de l'utilisateur ${data.telephone}:`,
        error,
      );
    }
  }
}
