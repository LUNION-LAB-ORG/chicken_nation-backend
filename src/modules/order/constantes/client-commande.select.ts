import { Prisma } from '@prisma/client';

/**
 * Le client tel qu'il accompagne une commande, dans les réponses et sur les
 * sockets.
 *
 * C'est tout ce que lisent la caisse, le back office et l'application client.
 * Les réglages de notification n'y figurent jamais : ils portent le jeton Expo
 * et les identifiants OneSignal du téléphone, et une commande part vers tout
 * le personnel du restaurant et tous les comptes du back office.
 */
export const CLIENT_COMMANDE_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  email: true,
  image: true,
} as const satisfies Prisma.CustomerSelect;
