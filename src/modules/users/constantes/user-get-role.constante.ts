import { UserRole } from "@prisma/client";

export const userGetRole = (role: UserRole) => {
    switch (role) {
        case UserRole.ADMIN:
            return 'Administrateur';
        case UserRole.MARKETING:
            return 'Marketing';
        case UserRole.COMPTABLE:
            return 'Comptable';
        case UserRole.MANAGER:
            return 'Manager';
        case UserRole.CAISSIER:
            return 'Caissier';
        case UserRole.CALL_CENTER:
            return 'Call Center';
        case UserRole.CUISINE:
            return 'Cuisinier';
        default:
            return 'Inconnu';
    }
}