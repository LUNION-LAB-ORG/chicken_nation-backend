/**
 * Les emojis autorisés en RÉACTION à un message.
 *
 * Liste FERMÉE, et la vraie raison n'est pas la modération : c'est le comptage.
 * « ❤️ » et « ❤ » sont deux chaînes différentes pour un seul cœur, la première
 * portant un sélecteur de variante invisible. Accepter n'importe quelle chaîne
 * ferait donc apparaître deux pastilles côte à côte pour la même intention,
 * sans que personne comprenne pourquoi. En n'acceptant que ces valeurs exactes,
 * une réaction est toujours comparable à une autre.
 *
 * Ce sont les six de WhatsApp, que tout le monde reconnaît sans explication.
 */
export const EMOJIS_REACTION = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export type EmojiReaction = (typeof EMOJIS_REACTION)[number];

/** `true` si la chaîne est exactement l'un des emojis autorisés. */
export const estEmojiAutorise = (valeur: unknown): valeur is EmojiReaction =>
  typeof valeur === 'string' && (EMOJIS_REACTION as readonly string[]).includes(valeur);

/**
 * Forme AGRÉGÉE d'une réaction, telle que les écrans la consomment.
 *
 * Calculée par le serveur et non par chaque client : le compte et le « est-ce
 * moi » se déduisent tous deux de la liste brute, et les recalculer sur trois
 * applications différentes garantirait trois résultats différents. La liste
 * n'est jamais nominative : savoir QUI a mis un pouce n'intéresse personne et
 * exposerait des identités sans raison.
 */
export interface ReactionAgregee {
  emoji: string;
  /** Combien de personnes ont posé cet emoji. */
  count: number;
  /** L'ai-je posé moi-même ? Décide de l'état du bouton. */
  mine: boolean;
}

/**
 * Regroupe des réactions brutes en pastilles affichables.
 *
 * `monId` peut être nul (lecture non authentifiée, message système) : tout est
 * alors simplement à `mine: false`. L'ordre suit celui de la liste autorisée,
 * pour que les pastilles ne dansent pas d'un rendu à l'autre.
 */
export const agregerReactions = (
  reactions: { emoji: string; userId?: string | null; customerId?: string | null; delivererId?: string | null }[] | undefined | null,
  monId: string | null | undefined,
): ReactionAgregee[] => {
  if (!reactions?.length) return [];

  const parEmoji = new Map<string, ReactionAgregee>();
  for (const reaction of reactions) {
    const courante = parEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
    courante.count += 1;
    if (
      monId &&
      (reaction.userId === monId || reaction.customerId === monId || reaction.delivererId === monId)
    ) {
      courante.mine = true;
    }
    parEmoji.set(reaction.emoji, courante);
  }

  const rang = (emoji: string) => {
    const i = (EMOJIS_REACTION as readonly string[]).indexOf(emoji);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...parEmoji.values()].sort((a, b) => rang(a.emoji) - rang(b.emoji));
};
