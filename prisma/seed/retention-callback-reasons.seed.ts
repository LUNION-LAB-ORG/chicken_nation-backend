import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const REASONS = [
  { name: 'Rapport qualité prix', description: 'Le client estime que le rapport qualité/prix ne correspond pas à ses attentes', position: 0 },
  { name: 'Livraison retardée', description: 'Le client a subi des retards de livraison répétés', position: 1 },
  { name: 'Cherté de la livraison', description: 'Les frais de livraison sont jugés trop élevés', position: 2 },
  { name: 'Qualité du poulet', description: 'Le client n\'est pas satisfait de la qualité des produits', position: 3 },
  { name: 'Promo non accessible', description: 'Le client n\'a pas pu bénéficier des promotions en cours', position: 4 },
];

export async function retentionCallbackReasonsSeed() {
  console.log('🌱 Seeding retention callback reasons...');

  for (const reason of REASONS) {
    const existing = await prisma.retentionCallbackReason.findFirst({
      where: { name: reason.name },
    });

    if (!existing) {
      await prisma.retentionCallbackReason.create({ data: reason });
      console.log(`  ✅ Created: ${reason.name}`);
    } else {
      console.log(`  ⏭️  Already exists: ${reason.name}`);
    }
  }

  console.log('✅ Retention callback reasons seed done.');
}
