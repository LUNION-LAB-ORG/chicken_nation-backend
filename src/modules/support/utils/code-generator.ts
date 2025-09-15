/**
 * Génère un code séquentiel pour un ticket à partir du dernier numéro de ticket
 * 
 * @param prefix - Le préfixe à utiliser (ex: "SUPP")
 * @param lastNumber - Le dernier numéro utilisé
 * @param padLength - Longueur totale de la partie numérique (défaut: 5)
 * @returns Un code séquentiel formaté (ex: "SUPP-00123")
 */
export function generateSequentialTicketCode(
    prefix: string,
    lastNumber: number,
    padLength: number = 5
): string {
    // Incrémente le dernier numéro
    const nextNumber = lastNumber + 1;

    // Convertit en chaîne et ajoute des zéros au début
    const paddedNumber = nextNumber.toString().padStart(padLength, '0');

    return `${prefix}-${paddedNumber}`;
}

/**
 * Génère un préfixe de 3 lettres à partir de la catégorie du ticket
 * 
 * @param category - La catégorie du ticket (ex: "Support Technique", "Facturation", etc.)
 * @returns Un préfixe de 3 lettres majuscules
 */
export function generateTicketPrefix(category: string): string {
    if (!category || category.trim().length === 0) {
        return 'TIC'; // Préfixe par défaut si la catégorie est vide
    }

    // Nettoyer la chaîne: enlever les espaces et caractères spéciaux
    const cleanedCategory = category
        .normalize('NFD')                   // Normalisation Unicode
        .replace(/[\u0300-\u036f]/g, '')   // Supprime les accents
        .replace(/[^a-zA-Z0-9]/g, '');     // Garde uniquement les alphanumériques

    // Prendre les 3 premières lettres, ou compléter si moins de 3 lettres
    const prefix = cleanedCategory.substring(0, 3).padEnd(3, 'X');

    return prefix.toUpperCase();
}