import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { DishOptionGroupDto } from '../dto/dish-option-group.dto';

/**
 * MENUS COMPOSABLES — configuration des groupes d'options d'un plat.
 *
 * Un plat composable pose des questions au client avant d'entrer au panier :
 * « quelle sauce ? », « quel format ? ». Chaque question est un GROUPE, chaque
 * réponse possible un CHOIX qui porte SON prix POUR CE PLAT.
 *
 * Ce service ne sert que le personnel. Rien de ce qu'il écrit n'est visible des
 * applications tant que le verrou de visibilité n'est pas levé : voir
 * `composableClause` dans `dish-audience.util.ts`.
 */
@Injectable()
export class DishOptionService {
  private readonly logger = new Logger(DishOptionService.name);

  constructor(private readonly prisma: PrismaService) { }

  /** Arbre complet d'un plat, dans l'ordre d'affichage. */
  async findByDish(dishId: string) {
    const dish = await this.prisma.dish.findUnique({
      where: { id: dishId },
      select: { id: true, composable: true },
    });
    if (!dish) throw new NotFoundException('Plat non trouvé');

    const groups = await this.prisma.dishOptionGroup.findMany({
      where: { dish_id: dishId },
      orderBy: { position: 'asc' },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { supplement: { select: { id: true, name: true, price: true } } },
        },
      },
    });

    return { dish_id: dish.id, composable: dish.composable, groups };
  }

  /**
   * Vérifie qu'une configuration se tient AVANT de l'écrire. Un groupe mal
   * borné (« choisis entre 2 et 1 sauce », « obligatoire mais minimum zéro »)
   * bloquerait le client dans l'écran de composition sans qu'il puisse rien y
   * faire : ces incohérences se refusent ici, pas sur le téléphone.
   */
  private valider(groups: DishOptionGroupDto[]) {
    const titres = new Set<string>();

    groups.forEach((g, index) => {
      const ou = `Groupe « ${g.name || `n° ${index + 1}`} »`;

      const titre = g.name.trim().toLowerCase();
      if (titres.has(titre)) {
        throw new BadRequestException(`${ou} : deux groupes portent le même titre`);
      }
      titres.add(titre);

      const requis = g.required ?? true;
      const min = g.min_select ?? (requis ? 1 : 0);
      const max = g.max_select ?? 1;

      if (max < min) {
        throw new BadRequestException(
          `${ou} : le maximum (${max}) est inférieur au minimum (${min})`,
        );
      }
      if (requis && min < 1) {
        throw new BadRequestException(
          `${ou} : un groupe obligatoire demande au moins un choix`,
        );
      }
      if (max > g.items.length) {
        throw new BadRequestException(
          `${ou} : le maximum (${max}) dépasse le nombre de choix proposés (${g.items.length})`,
        );
      }

      // Un choix indisponible ne peut pas satisfaire le minimum. Sans ce
      // contrôle, un groupe obligatoire dont toutes les sauces sont en rupture
      // rendrait le plat impossible à commander, sans message compréhensible.
      const proposables = g.items.filter((i) => i.available !== false).length;
      if (requis && proposables < min) {
        throw new BadRequestException(
          `${ou} : ${proposables} choix disponible(s) pour un minimum de ${min}`,
        );
      }

      const libelles = new Set<string>();
      for (const item of g.items) {
        const libelle = item.label.trim().toLowerCase();
        if (libelles.has(libelle)) {
          throw new BadRequestException(
            `${ou} : le choix « ${item.label} » apparaît deux fois`,
          );
        }
        libelles.add(libelle);
      }

      const defauts = g.items.filter((i) => i.is_default).length;
      if (defauts > max) {
        throw new BadRequestException(
          `${ou} : ${defauts} choix présélectionnés pour un maximum de ${max}`,
        );
      }
    });
  }

  /**
   * Remplace la configuration d'un plat par celle reçue.
   *
   * Le remplacement conserve les identifiants transmis au lieu de tout
   * supprimer puis tout recréer : une fois que des commandes référenceront ces
   * choix, effacer et recréer briserait la trace de ce qui a été vendu.
   */
  async replaceForDish(dishId: string, groups: DishOptionGroupDto[]) {
    const dish = await this.prisma.dish.findUnique({
      where: { id: dishId },
      select: { id: true },
    });
    if (!dish) throw new NotFoundException('Plat non trouvé');

    this.valider(groups);

    // Les suppléments rattachés doivent exister, sinon la clé étrangère lâche
    // au milieu de la transaction avec un message illisible pour le gestionnaire.
    const supplementIds = [
      ...new Set(
        groups.flatMap((g) => g.items.map((i) => i.supplement_id).filter((v): v is string => !!v)),
      ),
    ];
    if (supplementIds.length) {
      const connus = await this.prisma.supplement.count({
        where: { id: { in: supplementIds } },
      });
      if (connus !== supplementIds.length) {
        throw new BadRequestException(
          "Un des suppléments rattachés n'existe plus dans le catalogue",
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const existants = await tx.dishOptionGroup.findMany({
        where: { dish_id: dishId },
        select: { id: true, items: { select: { id: true } } },
      });

      const groupesGardes = new Set(
        groups.map((g) => g.id).filter((v): v is string => !!v),
      );
      const groupesASupprimer = existants
        .filter((g) => !groupesGardes.has(g.id))
        .map((g) => g.id);
      if (groupesASupprimer.length) {
        // Les choix partent en cascade avec leur groupe.
        await tx.dishOptionGroup.deleteMany({ where: { id: { in: groupesASupprimer } } });
      }

      for (const [position, g] of groups.entries()) {
        const requis = g.required ?? true;
        const donnees = {
          name: g.name.trim(),
          description: g.description?.trim() || null,
          required: requis,
          min_select: g.min_select ?? (requis ? 1 : 0),
          max_select: g.max_select ?? 1,
          position,
        };

        const groupe = g.id
          ? await tx.dishOptionGroup.update({ where: { id: g.id }, data: donnees })
          : await tx.dishOptionGroup.create({ data: { ...donnees, dish_id: dishId } });

        const choixGardes = new Set(
          g.items.map((i) => i.id).filter((v): v is string => !!v),
        );
        const anciens = existants.find((e) => e.id === groupe.id)?.items ?? [];
        const choixASupprimer = anciens
          .filter((i) => !choixGardes.has(i.id))
          .map((i) => i.id);
        if (choixASupprimer.length) {
          await tx.dishOptionItem.deleteMany({ where: { id: { in: choixASupprimer } } });
        }

        for (const [rang, item] of g.items.entries()) {
          const donneesChoix = {
            label: item.label.trim(),
            price_delta: item.price_delta ?? 0,
            supplement_id: item.supplement_id || null,
            is_default: item.is_default ?? false,
            available: item.available ?? true,
            position: rang,
          };
          if (item.id) {
            await tx.dishOptionItem.update({ where: { id: item.id }, data: donneesChoix });
          } else {
            await tx.dishOptionItem.create({
              data: { ...donneesChoix, group_id: groupe.id },
            });
          }
        }
      }

      // Le marqueur suit la configuration : un plat sans groupe redevient un
      // plat ordinaire, et le personnel n'a pas à cocher une case de plus.
      await tx.dish.update({
        where: { id: dishId },
        data: { composable: groups.length > 0 },
      });
    }, {
      // Un arbre de dix groupes enchaîne beaucoup d'écritures ; le délai par
      // défaut de Prisma (5 s) est court pour une base distante comme Neon.
      timeout: 20_000,
    });

    this.logger.log(
      `Configuration composable du plat ${dishId} : ${groups.length} groupe(s)`,
    );
    return this.findByDish(dishId);
  }

  /**
   * Duplique la configuration d'un plat vers un autre. Les huit burgers de la
   * carte partagent la même grille de sauces : la recopier à la main huit fois
   * serait long et source d'écarts.
   */
  async copierVers(sourceDishId: string, cibleDishId: string) {
    if (sourceDishId === cibleDishId) {
      throw new BadRequestException('Le plat source et le plat cible sont identiques');
    }
    const { groups } = await this.findByDish(sourceDishId);
    if (groups.length === 0) {
      throw new BadRequestException("Le plat source n'a aucun groupe d'options");
    }
    // Sans identifiant, chaque groupe et chaque choix est recréé pour la cible.
    const copie: DishOptionGroupDto[] = groups.map((g) => ({
      name: g.name,
      description: g.description,
      required: g.required,
      min_select: g.min_select,
      max_select: g.max_select,
      items: g.items.map((i) => ({
        label: i.label,
        price_delta: i.price_delta,
        supplement_id: i.supplement_id,
        is_default: i.is_default,
        available: i.available,
      })),
    }));
    return this.replaceForDish(cibleDishId, copie);
  }

  /**
   * Prix des choix retenus, calculé DEPUIS LA BASE et jamais depuis ce que
   * l'application annonce. C'est le point d'entrée que la prise de commande
   * utilisera : un client qui manipulerait la requête pour s'offrir un format
   * XL à zéro franc verrait quand même le vrai tarif appliqué.
   *
   * Vérifie aussi que les réponses respectent les bornes des groupes.
   */
  async resoudreSelection(
    dishId: string,
    optionItemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<{ total: number; items: { id: string; label: string; price_delta: number; group_name: string; supplement_id: string | null }[] }> {
    const client = tx ?? this.prisma;

    const groups = await client.dishOptionGroup.findMany({
      where: { dish_id: dishId },
      orderBy: { position: 'asc' },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    if (groups.length === 0) {
      if (optionItemIds.length > 0) {
        throw new BadRequestException("Ce plat ne propose pas d'options");
      }
      return { total: 0, items: [] };
    }

    const demandes = new Set(optionItemIds);
    const retenus: { id: string; label: string; price_delta: number; group_name: string; supplement_id: string | null }[] = [];
    let total = 0;
    let reconnus = 0;

    for (const groupe of groups) {
      const choisis = groupe.items.filter((i) => demandes.has(i.id));
      reconnus += choisis.length;

      if (choisis.length < groupe.min_select) {
        throw new BadRequestException(
          `« ${groupe.name} » : ${groupe.min_select} choix attendu(s) au minimum`,
        );
      }
      if (choisis.length > groupe.max_select) {
        throw new BadRequestException(
          `« ${groupe.name} » : ${groupe.max_select} choix au maximum`,
        );
      }
      const indisponible = choisis.find((i) => !i.available);
      if (indisponible) {
        throw new BadRequestException(
          `« ${indisponible.label} » n'est plus disponible`,
        );
      }

      for (const choix of choisis) {
        total += choix.price_delta;
        retenus.push({
          id: choix.id,
          label: choix.label,
          price_delta: choix.price_delta,
          group_name: groupe.name,
          supplement_id: choix.supplement_id,
        });
      }
    }

    // Un identifiant qui n'appartient à aucun groupe de CE plat est une erreur
    // franche, pas une ligne à ignorer en silence.
    if (reconnus !== demandes.size) {
      throw new BadRequestException("Un des choix envoyés n'appartient pas à ce plat");
    }

    return { total, items: retenus };
  }
}
