/**
 * Service de synchronisation des clients HubRise ↔ Chicken Nation.
 *
 * Flux de synchronisation :
 *
 * 1. HubRise → CN (PULL) :
 *    - Récupérer les clients HubRise et les rapprocher par téléphone
 *    - Créer ou mettre à jour les clients et leurs adresses dans CN
 *
 * 2. CN → HubRise (PUSH) :
 *    - Envoyer les infos client CN vers HubRise
 *    - Utile pour maintenir la liste de clients à jour
 *
 * ⚠️ Contraintes :
 * - Le téléphone est la CLÉ UNIQUE de rapprochement (Customer.phone dans CN)
 * - Les clients HubRise SANS téléphone sont ignorés
 * - L'email est unique et optionnel dans CN — conflit possible si l'email
 *   existe déjà sur un autre client CN → on ne met pas à jour l'email dans ce cas
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { EntityStatus } from '@prisma/client';
import { HubriseApiService } from './hubrise-api.service';
import { HUBRISE_CUSTOMERS } from '../constants/hubrise-endpoints.constant';
import { HubriseCustomer } from '../interfaces/hubrise-customer.interface';
import {
  mapHubriseCustomerToCN,
  mapCNCustomerToHubrise,
  canSyncCustomer,
  normalizePhone,
  MappedCustomer,
} from '../mappers/customer.mapper';

@Injectable()
export class HubriseCustomerSyncService {
  private readonly logger = new Logger(HubriseCustomerSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubriseApi: HubriseApiService,
  ) {}

  // ─── HubRise → Chicken Nation ──────────────────────────────────────

  /**
   * Synchronise un client HubRise dans Chicken Nation.
   * Appelé après réception d'un webhook customer.create ou customer.update.
   *
   * @param locationId - ID du location HubRise
   * @param customerId - ID du client HubRise
   * @param accessToken - Token d'accès HubRise
   */
  async syncCustomerFromHubrise(
    locationId: string,
    customerId: string,
    accessToken: string,
  ): Promise<void> {
    this.logger.log(`[HubRise Customer] Sync client ${customerId} depuis location ${locationId}`);

    try {
      // 1. Récupérer les détails du client via l'API
      const hubriseCustomer = await this.hubriseApi.request<HubriseCustomer>({
        method: 'GET',
        url: HUBRISE_CUSTOMERS.GET(locationId, customerId),
        accessToken,
      });

      // 2. Vérifier si le client peut être synchronisé (téléphone requis)
      if (!canSyncCustomer(hubriseCustomer)) {
        this.logger.warn(
          `[HubRise Customer] Client ${customerId} ignoré — pas de téléphone`,
        );
        return;
      }

      // 3. Mapper et synchroniser
      const mapped = mapHubriseCustomerToCN(hubriseCustomer);
      await this.upsertCustomer(mapped);
    } catch (error) {
      this.logger.error(`[HubRise Customer] Erreur sync client ${customerId} : ${error}`);
      throw error;
    }
  }

  /**
   * Importe tous les clients HubRise d'un location dans CN.
   * Utile pour la synchronisation initiale.
   *
   * @param locationId - ID du location HubRise
   * @param accessToken - Token d'accès HubRise
   * @returns Résumé de l'import
   */
  async pullAllCustomers(
    locationId: string,
    accessToken: string,
  ): Promise<CustomerSyncResult> {
    this.logger.log(`[HubRise Customer] Import de tous les clients du location ${locationId}`);

    const result: CustomerSyncResult = {
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
    };

    try {
      // Récupérer tous les clients avec pagination
      const customers = await this.hubriseApi.fetchAllPages<HubriseCustomer>(
        HUBRISE_CUSTOMERS.LIST(locationId),
        accessToken,
      );

      result.total = customers.length;

      for (const hubriseCustomer of customers) {
        // Ignorer les clients sans téléphone
        if (!canSyncCustomer(hubriseCustomer)) {
          result.skipped++;
          continue;
        }

        const mapped = mapHubriseCustomerToCN(hubriseCustomer);
        const wasCreated = await this.upsertCustomer(mapped);
        if (wasCreated) {
          result.created++;
        } else {
          result.updated++;
        }
      }

      this.logger.log(
        `[HubRise Customer] Import terminé — Total: ${result.total}, ` +
        `Créés: ${result.created}, Mis à jour: ${result.updated}, Ignorés: ${result.skipped}`,
      );

      return result;
    } catch (error) {
      this.logger.error(`[HubRise Customer] Erreur import : ${error}`);
      throw error;
    }
  }

  // ─── Chicken Nation → HubRise ──────────────────────────────────────

  /**
   * Envoie un client CN vers HubRise.
   *
   * @param customerId - ID du client CN
   * @param locationId - ID du location HubRise
   * @param accessToken - Token d'accès HubRise
   */
  async pushCustomerToHubrise(
    customerId: string,
    locationId: string,
    accessToken: string,
  ): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { addresses: true },
    });

    if (!customer) {
      this.logger.warn(`[HubRise Customer] Client CN ${customerId} introuvable`);
      return;
    }

    const payload = mapCNCustomerToHubrise({
      id: customer.id,
      phone: customer.phone,
      first_name: customer.first_name,
      last_name: customer.last_name,
      email: customer.email,
      addresses: customer.addresses,
    });

    try {
      await this.hubriseApi.request({
        method: 'POST',
        url: HUBRISE_CUSTOMERS.CREATE(locationId),
        accessToken,
        body: payload as unknown as Record<string, unknown>,
      });

      this.logger.log(`[HubRise Customer] Client ${customer.phone} envoyé à HubRise`);
    } catch (error) {
      this.logger.error(`[HubRise Customer] Erreur push client ${customerId} : ${error}`);
    }
  }

  // ─── Utilitaires internes ──────────────────────────────────────────

  /**
   * Crée ou met à jour un client CN à partir des données mappées.
   * @returns true si le client a été créé, false s'il a été mis à jour
   */
  private async upsertCustomer(mapped: MappedCustomer): Promise<boolean> {
    if (!mapped.phone) return false;

    // Chercher le client par téléphone
    const existing = await this.prisma.customer.findUnique({
      where: { phone: mapped.phone },
      select: { id: true, email: true },
    });

    if (existing) {
      // Mise à jour — vérifier le conflit d'email avant
      const updateData: Record<string, unknown> = {};
      if (mapped.firstName) updateData.first_name = mapped.firstName;
      if (mapped.lastName) updateData.last_name = mapped.lastName;

      // Ne mettre à jour l'email que s'il n'est pas déjà utilisé par un autre client
      if (mapped.email && mapped.email !== existing.email) {
        const emailConflict = await this.prisma.customer.findUnique({
          where: { email: mapped.email },
          select: { id: true },
        });
        if (!emailConflict) {
          updateData.email = mapped.email;
        } else {
          this.logger.warn(
            `[HubRise Customer] Email "${mapped.email}" déjà utilisé par un autre client CN. Non mis à jour.`,
          );
        }
      }

      if (Object.keys(updateData).length > 0) {
        await this.prisma.customer.update({
          where: { id: existing.id },
          data: updateData,
        });
      }

      // Synchroniser les adresses
      await this.syncAddresses(existing.id, mapped.addresses);

      return false;
    } else {
      // Création
      const created = await this.prisma.customer.create({
        data: {
          phone: mapped.phone,
          first_name: mapped.firstName,
          last_name: mapped.lastName,
          email: mapped.email,
          entity_status: EntityStatus.ACTIVE,
        },
        select: { id: true },
      });

      // Ajouter les adresses
      await this.syncAddresses(created.id, mapped.addresses);

      return true;
    }
  }

  /**
   * Synchronise les adresses d'un client.
   * Ajoute les nouvelles adresses (ne supprime pas les existantes).
   */
  private async syncAddresses(
    customerId: string,
    addresses: MappedCustomer['addresses'],
  ): Promise<void> {
    for (const addr of addresses) {
      // Vérifier si une adresse similaire existe déjà (même lat/lng)
      if (addr.latitude === 0 && addr.longitude === 0) continue;

      const existing = await this.prisma.address.findFirst({
        where: {
          customer_id: customerId,
          latitude: { gte: addr.latitude - 0.001, lte: addr.latitude + 0.001 },
          longitude: { gte: addr.longitude - 0.001, lte: addr.longitude + 0.001 },
        },
      });

      if (!existing) {
        await this.prisma.address.create({
          data: {
            customer_id: customerId,
            title: addr.title,
            address: addr.address,
            street: addr.street,
            city: addr.city,
            latitude: addr.latitude,
            longitude: addr.longitude,
          },
        });
      }
    }
  }
}

// ─── Types de résultat ───────────────────────────────────────────────

export interface CustomerSyncResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
}
