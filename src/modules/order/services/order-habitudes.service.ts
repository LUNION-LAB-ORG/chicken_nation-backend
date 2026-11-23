import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityStatus, OrderStatus, User } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { commandeEffective } from 'src/modules/crm/crm.rules';
import { dishAudienceClause } from 'src/modules/menu/utils/dish-audience.util';
import {
  HABITUDES_FENETRE,
  HABITUDES_VIDES,
  HabitudesClient,
  cleExclusion,
  etablirHabitudes,
  lireSupplements,
} from '../helpers/habitudes-client.rules';
import { resolveRestaurantScope } from '../helpers/restaurant-scope.helper';

/**
 * Habitudes d'un client, pour la prise de commande du personnel : ses plats
 * les plus commandés et sa dernière commande. Lecture seule.
 */
@Injectable()
export class OrderHabitudesService {
  constructor(private readonly prisma: PrismaService) {}

  async duClient(user: User, customerId: string): Promise<HabitudesClient> {
    const client = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, profile_type: true, loyalty_level: true, entity_status: true },
    });
    if (!client || client.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException('Client introuvable.');
    }

    // Personnel d'un restaurant (caissier) : seulement les commandes de SON
    // restaurant, comme sur la fiche du client. Lu du jeton, jamais de la requête.
    const restaurantId = resolveRestaurantScope(user);

    const commandes = await this.prisma.order.findMany({
      where: {
        // Une commande qui compte : ni panier non payé, ni commande à confirmer.
        ...commandeEffective(customerId),
        // Annulée : le client ne l'a pas reçue, ce n'est pas une habitude.
        status: { not: OrderStatus.CANCELLED },
        ...(restaurantId ? { restaurant_id: restaurantId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: HABITUDES_FENETRE,
      select: {
        id: true,
        reference: true,
        created_at: true,
        type: true,
        amount: true,
        restaurant: { select: { id: true, name: true } },
        order_items: {
          orderBy: { created_at: 'asc' },
          select: {
            dish_id: true,
            quantity: true,
            amount: true,
            epice: true,
            supplements: true,
            options: true,
            dish: { select: { name: true, image: true } },
          },
        },
      },
    });
    if (commandes.length === 0) return HABITUDES_VIDES;

    const lignes = commandes.flatMap((commande) => commande.order_items);
    const platIds = [...new Set(lignes.map((ligne) => ligne.dish_id))];
    const supplementIds = [
      ...new Set(lignes.flatMap((ligne) => lireSupplements(ligne.supplements).map((s) => s.id))),
    ];

    // Le catalogue du jour, limité à ce que ces commandes citent. Même masque
    // que la grille des plats quand un client est choisi : actif, non privé,
    // dans son audience. Sans lui, un plat réservé resterait proposé alors que
    // la création de la commande le refuse.
    const [plats, supplements, exclusions] = await Promise.all([
      this.prisma.dish.findMany({
        where: {
          id: { in: platIds },
          entity_status: EntityStatus.ACTIVE,
          private: false,
          AND: [dishAudienceClause(client)],
        },
        select: { id: true },
      }),
      supplementIds.length > 0
        ? this.prisma.supplement.findMany({
            where: { id: { in: supplementIds }, available: true },
            select: { id: true },
          })
        : [],
      supplementIds.length > 0
        ? this.prisma.dishExcludedSupplement.findMany({
            where: { dish_id: { in: platIds }, supplement_id: { in: supplementIds } },
            select: { dish_id: true, supplement_id: true },
          })
        : [],
    ]);

    return etablirHabitudes(commandes, {
      plats: new Set(plats.map((plat) => plat.id)),
      supplements: new Set(supplements.map((supplement) => supplement.id)),
      exclusions: new Set(exclusions.map((e) => cleExclusion(e.dish_id, e.supplement_id))),
    });
  }
}
