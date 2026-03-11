/**
 * Service de synchronisation des commandes HubRise ↔ Chicken Nation.
 *
 * Flux de synchronisation :
 *
 * 1. HubRise → CN (réception de commande) :
 *    - Webhook reçu → récupérer les détails de la commande via API
 *    - Mapper les données (statut, type, items, client, adresse)
 *    - Résoudre les références : Dish.reference → dish_id, phone → customer_id
 *    - Créer ou mettre à jour la commande dans CN
 *
 * 2. CN → HubRise (mise à jour de statut) :
 *    - Quand un statut change dans CN, envoyer la mise à jour à HubRise
 *    - Mapper le statut CN → HubRise
 *
 * ⚠️ Contraintes :
 * - Les Dish doivent avoir un `reference` correspondant au `sku_ref` HubRise
 * - Les clients sont rapprochés par téléphone (Customer.phone)
 * - Si un plat n'est pas trouvé par référence, la commande est créée sans cet item
 *   et un log d'erreur est émis
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { EntityStatus, OrderStatus, Prisma } from '@prisma/client';
import { HubriseApiService } from './hubrise-api.service';
import { HUBRISE_ORDERS } from '../constants/hubrise-endpoints.constant';
import { HubriseOrder } from '../interfaces/hubrise-order.interface';
import {
  mapHubriseOrderToCN,
  MappedOrder,
  mapCNStatusToHubrise,
} from '../mappers/order.mapper';
import { normalizePhone } from '../mappers/customer.mapper';

@Injectable()
export class HubriseOrderSyncService {
  private readonly logger = new Logger(HubriseOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubriseApi: HubriseApiService,
  ) {}

  // ─── HubRise → Chicken Nation ──────────────────────────────────────

  /**
   * Synchronise une commande HubRise dans Chicken Nation.
   * Appelé après réception d'un webhook order.create ou order.update.
   *
   * @param locationId - ID du location HubRise
   * @param orderId - ID de la commande HubRise
   * @param accessToken - Token du restaurant
   */
  async syncOrderFromHubrise(
    locationId: string,
    orderId: string,
    accessToken: string,
  ): Promise<void> {
    this.logger.log(`[HubRise Sync] Synchronisation commande ${orderId} depuis location ${locationId}`);

    try {
      // 1. Récupérer les détails de la commande via l'API HubRise
      const hubriseOrder = await this.hubriseApi.request<HubriseOrder>({
        method: 'GET',
        url: HUBRISE_ORDERS.GET(locationId, orderId),
        accessToken,
      });

      // 2. Mapper les données
      const mapped = mapHubriseOrderToCN(hubriseOrder);

      // 3. Trouver le restaurant CN associé à ce location_id
      const restaurant = await this.findRestaurantByLocationId(locationId);
      if (!restaurant) {
        this.logger.error(`[HubRise Sync] Aucun restaurant CN trouvé pour le location ${locationId}`);
        return;
      }

      // 4. Vérifier si la commande existe déjà (mise à jour ou création)
      const existingOrder = await this.findOrderByHubriseId(mapped.hubriseOrderId);

      if (existingOrder) {
        await this.updateExistingOrder(existingOrder.id, mapped);
      } else {
        await this.createNewOrder(mapped, restaurant.id);
      }
    } catch (error) {
      this.logger.error(`[HubRise Sync] Erreur synchronisation commande ${orderId} : ${error}`);
      throw error;
    }
  }

  /**
   * Crée une nouvelle commande CN à partir des données HubRise.
   */
  private async createNewOrder(mapped: MappedOrder, restaurantId: string): Promise<void> {
    // 1. Résoudre le client par téléphone
    const customerId = await this.resolveCustomer(mapped.customer);
    if (!customerId) {
      this.logger.warn(
        `[HubRise Sync] Impossible de résoudre le client (tel: ${mapped.customer.phone}). Commande ${mapped.hubriseOrderId} ignorée.`,
      );
      return;
    }

    // 2. Résoudre les items (trouver les dish_id via Dish.reference)
    const resolvedItems = await this.resolveOrderItems(mapped.items);

    // 3. Générer une référence unique
    const reference = await this.generateReference();

    // 4. Calculer la taxe (même formule que dans order.service)
    const taxRate = parseFloat(process.env.ORDER_TAX_RATE ?? '0.005');
    const tax = mapped.netAmount * taxRate;

    // 5. Créer la commande
    await this.prisma.order.create({
      data: {
        reference,
        hubrise_order_id: mapped.hubriseOrderId,
        customer_id: customerId,
        restaurant_id: restaurantId,
        status: mapped.status,
        type: mapped.type,
        net_amount: mapped.netAmount,
        amount: mapped.totalAmount,
        delivery_fee: mapped.deliveryFee,
        discount: mapped.discount,
        tax,
        address: mapped.address as unknown as Prisma.InputJsonValue,
        note: mapped.note,
        fullname: mapped.customer.fullName,
        phone: mapped.customer.phone,
        email: mapped.customer.email,
        auto: false, // Commande venant de HubRise = pas de l'app (considérée comme call center / externe)
        paied: true, // On considère les commandes HubRise comme payées
        entity_status: EntityStatus.ACTIVE,
        order_items: {
          create: resolvedItems.map((item) => ({
            dish: { connect: { id: item.dishId } },
            quantity: item.quantity,
            amount: item.amount,
            supplements: item.supplements as Prisma.InputJsonValue ?? undefined,
          })),
        },
      },
    });

    this.logger.log(
      `[HubRise Sync] Commande ${mapped.hubriseOrderId} créée → référence ${reference}`,
    );
  }

  /**
   * Met à jour une commande CN existante (changement de statut depuis HubRise).
   */
  private async updateExistingOrder(orderId: string, mapped: MappedOrder): Promise<void> {
    // Mettre à jour le statut et les timestamps associés
    const updateData: Record<string, unknown> = {
      status: mapped.status,
    };

    // Ajouter les timestamps selon le nouveau statut
    const now = new Date();
    switch (mapped.status) {
      case OrderStatus.ACCEPTED:
        updateData.accepted_at = now;
        break;
      case OrderStatus.IN_PROGRESS:
        updateData.prepared_at = now;
        break;
      case OrderStatus.READY:
        updateData.ready_at = now;
        break;
      case OrderStatus.PICKED_UP:
        updateData.picked_up_at = now;
        break;
      case OrderStatus.COLLECTED:
        updateData.collected_at = now;
        break;
      case OrderStatus.COMPLETED:
        updateData.completed_at = now;
        break;
      case OrderStatus.CANCELLED:
        updateData.cancelled_at = now;
        break;
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });

    this.logger.log(
      `[HubRise Sync] Commande ${orderId} mise à jour → statut ${mapped.status}`,
    );
  }

  // ─── Chicken Nation → HubRise ──────────────────────────────────────

  /**
   * Envoie une mise à jour de statut à HubRise quand une commande CN change.
   * Appelé par le listener d'événements order.
   *
   * @param orderId - ID de la commande CN
   * @param newStatus - Nouveau statut CN
   */
  async pushStatusToHubrise(orderId: string, newStatus: OrderStatus): Promise<void> {
    // Récupérer la commande avec les infos HubRise
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        hubrise_order_id: true,
        restaurant: {
          select: {
            hubrise_access_token: true,
            hubrise_location_id: true,
          },
        },
      },
    });

    // Ignorer si la commande n'est pas liée à HubRise
    if (!order?.hubrise_order_id || !order.restaurant.hubrise_location_id) {
      return;
    }

    const hubriseStatus = mapCNStatusToHubrise(newStatus);
    const locationId = order.restaurant.hubrise_location_id;
    const accessToken = order.restaurant.hubrise_access_token;

    if (!accessToken) {
      this.logger.warn(`[HubRise Sync] Pas de token pour mettre à jour la commande ${orderId}`);
      return;
    }

    try {
      await this.hubriseApi.request({
        method: 'PUT',
        url: HUBRISE_ORDERS.UPDATE(locationId, order.hubrise_order_id),
        accessToken,
        body: { status: hubriseStatus },
      });

      this.logger.log(
        `[HubRise Sync] Statut ${hubriseStatus} envoyé à HubRise pour la commande ${order.hubrise_order_id}`,
      );
    } catch (error) {
      this.logger.error(
        `[HubRise Sync] Erreur push statut HubRise pour ${orderId}: ${error}`,
      );
    }
  }

  // ─── Résolution des entités ────────────────────────────────────────

  /**
   * Trouve le restaurant CN correspondant à un location_id HubRise.
   */
  private async findRestaurantByLocationId(locationId: string) {
    return this.prisma.restaurant.findFirst({
      where: {
        hubrise_location_id: locationId,
        entity_status: EntityStatus.ACTIVE,
      },
      select: { id: true, name: true },
    });
  }

  /**
   * Trouve une commande CN existante par son ID HubRise.
   */
  private async findOrderByHubriseId(hubriseOrderId: string) {
    return this.prisma.order.findFirst({
      where: { hubrise_order_id: hubriseOrderId },
      select: { id: true, status: true },
    });
  }

  /**
   * Résout ou crée le client CN à partir des infos de la commande HubRise.
   * Le téléphone est la clé de rapprochement principale.
   *
   * @returns ID du client CN, ou null si impossible de résoudre
   */
  private async resolveCustomer(customerData: MappedOrder['customer']): Promise<string | null> {
    const phone = normalizePhone(customerData.phone);
    if (!phone) return null;

    // Chercher le client par téléphone
    let customer = await this.prisma.customer.findUnique({
      where: { phone },
      select: { id: true },
    });

    // Si le client n'existe pas, le créer
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          phone,
          first_name: customerData.firstName,
          last_name: customerData.lastName,
          email: customerData.email,
          entity_status: EntityStatus.ACTIVE,
        },
        select: { id: true },
      });

      this.logger.log(`[HubRise Sync] Nouveau client créé : ${phone}`);
    }

    return customer.id;
  }

  /**
   * Résout les items de commande en trouvant les dish_id via Dish.reference.
   * Les items sans correspondance sont ignorés avec un log d'avertissement.
   */
  private async resolveOrderItems(
    items: MappedOrder['items'],
  ): Promise<Array<{
    dishId: string;
    quantity: number;
    amount: number;
    supplements: unknown;
  }>> {
    const resolvedItems: Array<{
      dishId: string;
      quantity: number;
      amount: number;
      supplements: unknown;
    }> = [];

    for (const item of items) {
      let dish: { id: string } | null = null;

      // Chercher par référence d'abord
      if (item.dishReference) {
        dish = await this.prisma.dish.findUnique({
          where: { reference: item.dishReference },
          select: { id: true },
        });
      }

      // Fallback : chercher par nom exact
      if (!dish) {
        dish = await this.prisma.dish.findFirst({
          where: {
            name: item.productName,
            entity_status: EntityStatus.ACTIVE,
          },
          select: { id: true },
        });
      }

      if (!dish) {
        this.logger.warn(
          `[HubRise Sync] Plat introuvable : ref="${item.dishReference}", nom="${item.productName}". Item ignoré.`,
        );
        continue;
      }

      resolvedItems.push({
        dishId: dish.id,
        quantity: item.quantity,
        amount: item.amount,
        supplements: item.supplements.length > 0 ? item.supplements : null,
      });
    }

    return resolvedItems;
  }

  /**
   * Génère une référence unique pour une nouvelle commande.
   * Format : CN-HUBRISE-XXXXXX (6 caractères alphanumériques).
   */
  private async generateReference(): Promise<string> {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let reference: string;
    let exists = true;

    do {
      const code = Array.from({ length: 6 }, () =>
        chars[Math.floor(Math.random() * chars.length)],
      ).join('');
      reference = `HR-${code}`;

      const existing = await this.prisma.order.findUnique({
        where: { reference },
        select: { id: true },
      });
      exists = !!existing;
    } while (exists);

    return reference;
  }
}
