import { Customer, User } from '@prisma/client';

/**
 * Détermine le type d'authentification de l'utilisateur
 * @param auth - L'utilisateur authentifié (peut-être un User ou un Customer)
 * @returns 'user' si c'est un employé, 'customer' si c'est un client
 */
export function getAuthType(
  auth: Express.User | User | Customer,
): 'user' | 'customer' {
  return 'role' in auth ? 'user' : 'customer';
}