import { UserRole } from "@prisma/client";

export const userGetRole = (role: UserRole) => {
    switch (role) {
        case UserRole.ADMIN:
            return 'Administrateur';
        case UserRole.MARKETING:
            return 'Agent Marketing';
        case UserRole.COMPTABLE:
            return 'Agent Comptable';
        case UserRole.MANAGER:
            return 'Manager';
        case UserRole.CAISSIER:
            return 'Agent Caissier';
        case UserRole.CALL_CENTER:
            return 'Agent Call Center';
        case UserRole.CUISINE:
            return 'Agent Cuisinier';
        case UserRole.LIVRAISON_OPS:
            return 'Suivi Livraisons';
        default:
            return 'Inconnu';
    }
}