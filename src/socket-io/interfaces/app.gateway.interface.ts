import { UserRole } from '@prisma/client';

export interface ConnectedUser {
    id: string;
    type: 'customer' | 'user' | 'deliverer';
    userType?: 'BACKOFFICE' | 'RESTAURANT';
    restaurantId?: string;
    /** Rôle d'un membre du personnel : décide de la salle des relances. */
    role?: UserRole;
    socketId: string;
}