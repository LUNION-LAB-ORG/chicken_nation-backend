import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

export async function loyaltyConfigSeed() {
  const configData: Prisma.LoyaltyConfigCreateInput = {
    points_per_xof: 0.002,
    points_expiration_days: 365,
    minimum_redemption_points: 100,
    point_value_in_xof: 20,
    standard_threshold: 300,
    premium_threshold: 700,
    gold_threshold: 1000,
    is_active: true,
  };

  await prisma.loyaltyConfig.upsert({
    where: { is_active: configData.is_active },
    update: configData,
    create: configData,
  });
}
