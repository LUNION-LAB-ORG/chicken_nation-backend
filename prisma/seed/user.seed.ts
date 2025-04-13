import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { UserRole, UserType } from 'src/modules/users/enums/user.enum';

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
