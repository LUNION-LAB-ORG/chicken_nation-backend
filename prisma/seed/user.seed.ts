import { Prisma, PrismaClient, UserRole, UserType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function userSeed() {
  const datas: Prisma.UserCreateInput[] = [
    {
      fullname: 'Admin',
      email: 'admin@chicken-nation.com',
      password: 'Admin@2025',
      type: UserType.BACKOFFICE,
      role: UserRole.ADMIN,
    },
    {
      fullname: 'Manager',
      email: 'manager@chicken-nation.com',
      password: 'Manager@2025',
      type: UserType.RESTAURANT,
      role: UserRole.MANAGER,
    },
    {
      fullname: 'Cuisinier',
      email: 'cuisinier@chicken-nation.com',
      password: 'Cuisinier@2025',
      type: UserType.RESTAURANT,
      role: UserRole.CUISINE,
    },
    {
      fullname: 'Caissier',
      email: 'caissier@chicken-nation.com',
      password: 'Caissier@2025',
      type: UserType.RESTAURANT,
      role: UserRole.CAISSIER,
    },
  ];

  for (const data of datas) {
    const { password, ...rest } = data;
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);
    try {
      await prisma.user.upsert({
        where: { email: data.email },
        update: {
          ...rest,
          password: hash,
        },
        create: {
          ...rest,
          password: hash,
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
