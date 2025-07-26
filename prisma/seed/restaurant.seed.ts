import { EntityStatus, Prisma, PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function restaurantSeed() {
  const manager = await prisma.user.findFirst({ 
    where: { role: UserRole.MANAGER } 
  });

  if (!manager) throw new Error('Manager not found for restaurant');

  const restaurantData: Prisma.RestaurantCreateInput = {
    name: 'Chicken Nation Abidjan',
    manager: manager.id,
    description: 'Le meilleur poulet frit de Côte d\'Ivoire',
    address: 'Plateau, Rue du Commerce',
    latitude: 5.320357,
    longitude: -4.016107,
    phone: '+2252724252627',
    email: 'abidjan@chicken-nation.com',
    schedule: JSON.stringify([
      {"1":"08:00-22:00"},{"2":"08:00-22:00"},{"3":"08:00-22:00"},{"4":"08:00-22:00"},{"5":"08:00-22:00"},{"6":"08:00-22:00"},{"7":"08:00-22:00"}
    ]),
    entity_status: EntityStatus.ACTIVE,
    users: {
      connect: [
        { email: 'manager@chicken-nation.com' },
        { email: 'cuisinier@chicken-nation.com' },
        { email: 'caissier@chicken-nation.com' }
      ]
    }
  };

  await prisma.restaurant.upsert({
    where: { name: restaurantData.name },
    update: restaurantData,
    create: restaurantData,
  });
}
