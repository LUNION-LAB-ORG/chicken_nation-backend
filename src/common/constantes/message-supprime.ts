/**
 * Un message SUPPRIMÉ, tel qu'il est servi à tout le monde.
 *
 * Le texte remplace le corps original plutôt que de le vider : une bulle vide
 * ressemblerait à un défaut d'affichage, et les applications déjà installées
 * chez vos clients ne connaissent pas le drapeau `deleted`. En remplaçant le
 * texte côté serveur, elles affichent la bonne chose sans être mises à jour.
 */
export const CORPS_MESSAGE_SUPPRIME = 'Ce message a été supprimé';

/**
 * Nettoie un message supprimé avant de le servir.
 *
 * ⚠️ On retire AUSSI `meta` : une photo ou une note vocale y vit sous forme de
 * lien, et laisser le lien reviendrait à ne rien supprimer du tout. Et les
 * réactions : réagir à un message retiré n'a plus de sens, et les pastilles
 * resteraient accrochées à un contenu qui n'existe plus.
 */
export const masquerSiSupprime = <T extends { deletedAt?: Date | null }>(
  message: T,
): T & { body: string; meta: null; deleted: true } | T => {
  if (!message?.deletedAt) return message;
  return {
    ...message,
    body: CORPS_MESSAGE_SUPPRIME,
    meta: null,
    deleted: true as const,
  };
};
