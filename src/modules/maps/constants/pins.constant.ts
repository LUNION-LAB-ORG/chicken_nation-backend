/**
 * Pastilles posées sur la vignette d'itinéraire.
 *
 * Google n'accepte, sur un marqueur standard, qu'une couleur et UNE lettre.
 * D'où le « R » et le « C » de la première version, que personne n'a à
 * déchiffrer sur une carte. Ces deux images reprennent exactement les
 * marqueurs de l'application : rond orange à maison pour le restaurant, rond
 * ardoise à repère pour le client.
 *
 * Elles sont embarquées en base64 plutôt que posées en fichier : le
 * compilateur Nest ne recopie pas les ressources sans configuration, et une
 * image manquante en production ferait disparaître les marqueurs sans un mot.
 *
 * 56 × 56 pixels : au-delà, Google refuse ; en dessous, la maison devient
 * illisible une fois la carte réduite.
 */

const PIN_RESTAURANT_B64 = [
    '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',
    '5LIWPWYmAAAAAElFTkSuQmCC',
].join('');

const PIN_CLIENT_B64 = [
    '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',
].join('');

/**
 * Une `Map` et non un objet : la clé vient de l'URL, et un objet littéral
 * répond aussi pour `toString`, `constructor` ou `__proto__`, hérités de son
 * prototype. Le garde-fou « inconnu » les laissait passer, et le serveur
 * renvoyait alors une erreur 500 au lieu d'un 404.
 */
export const PINS_VIGNETTE = new Map<string, Buffer>([
  ['restaurant', Buffer.from(PIN_RESTAURANT_B64, 'base64')],
  ['client', Buffer.from(PIN_CLIENT_B64, 'base64')],
]);
