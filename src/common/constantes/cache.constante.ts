
/**
 * Génère une clé de cache unique pour une requête spécifique.
 * @param key la clé de la requête
 * @param params les paramètres de la requête
 * @returns la clé de cache
 */
export const getCacheKey = (key: string, params: Record<string, any>) => {
    const paramsString = Object.entries(params)
        .map(([key, value]) => value ? `${key}=${value}` : null)
        .filter(Boolean)
        .join('_');

    return `chicken-nation_${key}_${paramsString}`;
};