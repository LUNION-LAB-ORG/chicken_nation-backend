import { PrismaClient } from '@prisma/client';

/**
 * Un plat composable peut-il être OFFERT, et avec quelle composition ?
 *
 * Un cadeau ne passe par aucun écran de composition : l'application l'envoie
 * sans le moindre choix. Sur un plat composable, la commande entière était donc
 * refusée, articles payants compris, avec un message demandant au client
 * d'ouvrir depuis le panier un article qui ne s'y trouve pas. Tous les burgers
 * et tous les sandwichs de la carte étant composables, plus aucun ne pouvait
 * être offert, alors que ce sont les cadeaux les plus attendus.
 *
 * D'où cette composition par défaut, appliquée par le serveur. La règle vit
 * ici, dans une fonction libre plutôt que dans un service, pour que la
 * fidélité s'en serve sans que son module ait à dépendre de celui des menus.
 */

type ClientPrisma = Pick<PrismaClient, 'dishOptionGroup'>;

/**
 * Composition par défaut, groupe par groupe :
 *   1. le choix marqué par défaut, s'il est disponible ;
 *   2. sinon le moins cher des choix disponibles.
 *
 * Seuls les groupes qui EXIGENT une réponse sont pourvus : un groupe facultatif
 * reste vide, on n'ajoute rien que le client n'a pas demandé.
 *
 * Renvoie `null` si un groupe obligatoire n'a pas assez de choix disponibles.
 * La carte est alors mal configurée, et mieux vaut le dire que livrer un plat
 * incomplet en cuisine.
 */
export async function choixParDefaut(
  prisma: ClientPrisma,
  dishId: string,
): Promise<string[] | null> {
  const groupes = await prisma.dishOptionGroup.findMany({
    where: { dish_id: dishId },
    orderBy: { position: 'asc' },
    include: { items: { orderBy: [{ price_delta: 'asc' }, { position: 'asc' }] } },
  });

  const retenus: string[] = [];
  for (const groupe of groupes) {
    if (groupe.min_select <= 0) continue;

    const disponibles = groupe.items.filter((i) => i.available);
    if (disponibles.length < groupe.min_select) return null;

    // `items` arrive trié par prix croissant : à défaut de choix marqué par
    // défaut, le premier de la liste est le moins cher.
    const prioritaires = [
      ...disponibles.filter((i) => i.is_default),
      ...disponibles.filter((i) => !i.is_default),
    ];
    retenus.push(...prioritaires.slice(0, groupe.min_select).map((i) => i.id));
  }
  return retenus;
}

/**
 * Ce plat peut-il être offert tel qu'il est configuré ?
 *
 * Remplace l'ancien refus « ce plat se compose par le client », qui écartait
 * TOUS les plats composables. Un plat composable s'offre très bien dès lors que
 * chacun de ses groupes obligatoires propose assez de choix disponibles : la
 * composition par défaut s'applique alors d'elle-même, et elle n'est pas
 * facturée puisque le client n'a rien ajouté.
 */
export async function platOffrable(
  prisma: ClientPrisma,
  dishId: string,
): Promise<{ ok: boolean; raison?: string }> {
  const defaut = await choixParDefaut(prisma, dishId);
  if (defaut === null) {
    return {
      ok: false,
      raison:
        "un de ses choix obligatoires n'a aucune option disponible : le cadeau ne pourrait pas être composé",
    };
  }
  return { ok: true };
}

/**
 * Même question, mais sur une configuration QUI N'EST PAS ENCORE ENREGISTRÉE.
 *
 * Sert au moment de rendre un plat composable alors qu'un cadeau le désigne
 * déjà : c'est la configuration entrante qu'il faut juger, pas celle qui est
 * en base et qu'on s'apprête à remplacer.
 */
export function compositionOffrable(
  groupes: { min_select?: number; items: { available?: boolean }[] }[],
): { ok: boolean; raison?: string } {
  for (const groupe of groupes) {
    // `min_select` absent du formulaire = valeur par défaut du schéma, soit 1 :
    // le groupe est obligatoire, il doit donc être pourvu.
    const minimum = groupe.min_select ?? 1;
    if (minimum <= 0) continue;
    const disponibles = groupe.items.filter((i) => i.available !== false);
    if (disponibles.length < minimum) {
      return {
        ok: false,
        raison:
          "un de ses choix obligatoires n'aurait aucune option disponible : le cadeau ne pourrait plus être composé",
      };
    }
  }
  return { ok: true };
}
