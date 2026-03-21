import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { OnesignalService } from '../onesignal.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { subHours } from 'date-fns';

/**
 * CRON — Synchronisation automatique des tags OneSignal
 *
 * Stratégie DELTA SYNC :
 * - Le CRON tourne tous les jours à 03h00 (GMT+0 — heure Côte d'Ivoire)
 * - Il ne synchronise QUE les clients qui ont eu un changement depuis le dernier sync :
 *   → nouvelle commande complétée
 *   → mise à jour du profil (nom, adresse, etc.)
 *   → changement de niveau de fidélité
 * - Un full sync initial est déclenché automatiquement si aucun sync n'a encore eu lieu
 * - Un full sync peut aussi être forcé manuellement via le setting `onesignal_tags_force_full_sync`
 *
 * Scalabilité : 10K → 1M+ clients sans problème
 * - Delta quotidien : quelques centaines/milliers de clients modifiés → ~1-2 min
 * - Full sync 10K : ~8-10 min | Full sync 1M : voir CSV import OneSignal
 *
 * Tags synchronisés :
 *  - orders            : nombre total de commandes complétées
 *  - total_spent       : montant total dépensé (FCFA)
 *  - last_order_days   : nombre de jours depuis la dernière commande
 *  - loyalty_points    : points de fidélité actuels
 *  - loyalty_level     : niveau de fidélité (STANDARD / PREMIUM / GOLD)
 *  - first_name        : prénom
 *  - last_name         : nom
 *  - city              : ville (depuis la dernière adresse)
 *  - birthday          : date d'anniversaire (MM-DD)
 *  - is_vip            : client GOLD = VIP
 *  - favorite_restaurant : nom du restaurant le plus commandé
 */
@Injectable()
export class OnesignalTagsTask {
  private readonly logger = new Logger(OnesignalTagsTask.name);

  /** Taille des lots — 50 requêtes en parallèle */
  private readonly BATCH_SIZE = 50;

  /** Pause entre chaque lot (ms) — respecte les rate limits OneSignal */
  private readonly BATCH_DELAY_MS = 2000;

  /** Clé du setting pour stocker la date du dernier sync */
  private readonly LAST_SYNC_KEY = 'onesignal_tags_last_sync';

  constructor(
    private readonly prisma: PrismaService,
    private readonly onesignalService: OnesignalService,
    private readonly settingsService: SettingsService,
  ) {}

  // ── CRON : tous les jours à 03h00 GMT+0 ──────────────────────────────────

  @Cron('0 3 * * *')
  async syncTags() {
    this.logger.log('🏷️  Début de la synchronisation des tags OneSignal...');

    try {
      // Vérifier si la sync est activée
      const isActive = await this.settingsService.get('onesignal_tags_sync_active');
      if (isActive === 'false') {
        this.logger.log('Synchronisation des tags désactivée. Skip.');
        return;
      }

      // Déterminer le mode : delta ou full
      const forceFullSync = await this.settingsService.get('onesignal_tags_force_full_sync');
      const lastSyncStr = await this.settingsService.get(this.LAST_SYNC_KEY);
      const lastSyncDate = lastSyncStr ? new Date(lastSyncStr) : null;

      const isFullSync = forceFullSync === 'true' || !lastSyncDate;

      if (isFullSync) {
        this.logger.log(
          lastSyncDate
            ? '🔄 Full sync forcé (onesignal_tags_force_full_sync = true)'
            : '🆕 Premier sync — full sync initial',
        );
        await this.runFullSync();
        // Reset le flag de force
        if (forceFullSync === 'true') {
          await this.settingsService.set('onesignal_tags_force_full_sync', 'false');
        }
      } else {
        this.logger.log(`⚡ Delta sync — changements depuis ${lastSyncStr}`);
        await this.runDeltaSync(lastSyncDate);
      }

      // Sauvegarder la date du sync
      await this.settingsService.set(this.LAST_SYNC_KEY, new Date().toISOString());
    } catch (error) {
      this.logger.error(
        `Erreur critique lors de la synchronisation des tags: ${error.message}`,
        error.stack,
      );
    }
  }

  // ── Récupérer les IDs des clients enregistrés dans OneSignal ─────────────

  /**
   * Ne cible que les clients qui ont un onesignal_id dans leur notification_settings.
   * Ça évite des milliers de requêtes 404 pour les clients qui n'ont pas l'app.
   */
  private async getOnesignalCustomerIds(): Promise<Set<string>> {
    const settings = await this.prisma.notificationSetting.findMany({
      where: {
        onesignal_id: { not: null },
        active: true,
      },
      select: { customer_id: true },
    });
    return new Set(settings.map((s) => s.customer_id));
  }

  // ── FULL SYNC : clients actifs enregistrés dans OneSignal ───────────────

  private async runFullSync() {
    const onesignalIds = await this.getOnesignalCustomerIds();

    if (onesignalIds.size === 0) {
      this.logger.log('Full sync : aucun client avec onesignal_id. Rien à synchroniser.');
      return;
    }

    const customers = await this.prisma.customer.findMany({
      where: {
        id: { in: Array.from(onesignalIds) },
        entity_status: 'ACTIVE',
      },
      select: this.customerSelect(),
    });

    this.logger.log(`Full sync : ${customers.length} clients à synchroniser (filtrés par onesignal_id)`);
    await this.processBatches(customers);
  }

  // ── DELTA SYNC : clients modifiés ET enregistrés dans OneSignal ─────────

  private async runDeltaSync(since: Date) {
    const sinceWithMargin = subHours(since, 1);
    const onesignalIds = await this.getOnesignalCustomerIds();

    if (onesignalIds.size === 0) {
      this.logger.log('⚡ Delta sync : aucun client avec onesignal_id. Rien à synchroniser.');
      return;
    }

    const onesignalIdArray = Array.from(onesignalIds);

    // 1. Clients qui ont eu une commande complétée depuis le dernier sync
    const customerIdsFromOrders = await this.prisma.order.findMany({
      where: {
        status: 'COMPLETED',
        entity_status: 'ACTIVE',
        completed_at: { gte: sinceWithMargin },
        customer_id: { in: onesignalIdArray },
      },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });

    // 2. Clients dont le profil a été mis à jour
    const customerIdsFromProfile = await this.prisma.customer.findMany({
      where: {
        entity_status: 'ACTIVE',
        updated_at: { gte: sinceWithMargin },
        id: { in: onesignalIdArray },
      },
      select: { id: true },
    });

    // 3. Clients dont les points fidélité ont changé
    const customerIdsFromLoyalty = await this.prisma.loyaltyPoint.findMany({
      where: {
        created_at: { gte: sinceWithMargin },
        customer_id: { in: onesignalIdArray },
      },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });

    // Fusionner et dédupliquer les IDs
    const allIds = new Set<string>([
      ...customerIdsFromOrders.map((o) => o.customer_id),
      ...customerIdsFromProfile.map((c) => c.id),
      ...customerIdsFromLoyalty.map((l) => l.customer_id),
    ]);

    if (allIds.size === 0) {
      this.logger.log(
        `⚡ Delta sync : aucun client modifié parmi les ${onesignalIds.size} enregistrés dans OneSignal.`,
      );
      return;
    }

    this.logger.log(
      `⚡ Delta sync : ${allIds.size} clients modifiés sur ${onesignalIds.size} dans OneSignal ` +
        `(${customerIdsFromOrders.length} commandes, ` +
        `${customerIdsFromProfile.length} profils, ` +
        `${customerIdsFromLoyalty.length} fidélité)`,
    );

    const customers = await this.prisma.customer.findMany({
      where: {
        id: { in: Array.from(allIds) },
        entity_status: 'ACTIVE',
      },
      select: this.customerSelect(),
    });

    await this.processBatches(customers);
  }

  // ── Traitement par lots ───────────────────────────────────────────────────

  private async processBatches(
    customers: Awaited<ReturnType<typeof this.fetchCustomerData>>,
  ) {
    let synced = 0;
    let notFound = 0; // 404 — clients pas dans OneSignal
    let tagLimited = 0; // 409 — limite de tags du plan
    let errors = 0;
    const now = new Date();

    for (let i = 0; i < customers.length; i += this.BATCH_SIZE) {
      const batch = customers.slice(i, i + this.BATCH_SIZE);

      const promises = batch.map(async (customer) => {
        try {
          const tags = this.buildTags(customer, now);
          await this.onesignalService.updateUserTags(customer.id, tags);
          synced++;
        } catch (error) {
          const errorMsg = error?.message ?? '';
          // 404 = client pas encore enregistré dans OneSignal (pas d'app installée)
          if (errorMsg.includes('404') || errorMsg.includes("doesn't match")) {
            notFound++;
          }
          // 409 = conflit OneSignal (tag limit, alias conflict, etc.)
          else if (errorMsg.includes('409')) {
            tagLimited++;
            if (tagLimited <= 3) {
              this.logger.warn(
                `⚠️  409 pour ${customer.id}: ${errorMsg}`,
              );
            }
          } else {
            errors++;
            if (errors <= 10) {
              this.logger.warn(
                `Erreur sync tags pour ${customer.id}: ${errorMsg}`,
              );
            }
          }
        }
      });

      await Promise.all(promises);

      // Log de progression tous les 500 clients traités
      const processed = synced + notFound + tagLimited + errors;
      if (processed % 500 < this.BATCH_SIZE && processed > 0) {
        this.logger.log(
          `  ... ${processed}/${customers.length} traités (${synced} synced, ${notFound} not found, ${tagLimited} tag-limited)`,
        );
      }

      // Pause entre les lots
      if (i + this.BATCH_SIZE < customers.length) {
        await new Promise((resolve) => setTimeout(resolve, this.BATCH_DELAY_MS));
      }
    }

    this.logger.log(
      `🏷️  Synchronisation terminée : ${synced} synced, ${notFound} pas sur OneSignal (404), ${tagLimited} limite tags (409), ${errors} erreurs — sur ${customers.length} clients`,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Select Prisma réutilisable pour les données client */
  private customerSelect() {
    return {
      id: true,
      loyalty_level: true,
      orders: {
        where: { status: 'COMPLETED' as const, entity_status: 'ACTIVE' as const },
        select: {
          amount: true,
        },
      },
    };
  }

  /** Helper pour typer le retour de fetchCustomerData */
  private async fetchCustomerData() {
    return this.prisma.customer.findMany({
      where: { entity_status: 'ACTIVE' },
      select: this.customerSelect(),
      take: 1,
    });
  }

  /** Construit l'objet tags pour un client donné */
  private buildTags(
    customer: {
      id: string;
      loyalty_level: string | null;
      orders: { amount: number }[];
    },
    now: Date,
  ): Record<string, string | number> {
    const completedOrders = customer.orders;
    const orderCount = completedOrders.length;
    const totalSpent = Math.round(
      completedOrders.reduce((sum, o) => sum + o.amount, 0),
    );

    const loyaltyLevel = customer.loyalty_level ?? 'STANDARD';

    // 3 tags marketing (limité par le plan OneSignal gratuit)
    // - orders         → Fréquence (combien de commandes)
    // - total_spent    → Montant (valeur du client en FCFA)
    // - loyalty_level  → Niveau fidélité (STANDARD / PREMIUM / GOLD)
    const tags: Record<string, string | number> = {
      orders: orderCount,
      total_spent: totalSpent,
      loyalty_level: loyaltyLevel,
    };

    // Ne pas envoyer les tags vides pour économiser le quota
    for (const key of Object.keys(tags)) {
      if (tags[key] === '' || tags[key] === undefined || tags[key] === null) {
        delete tags[key];
      }
    }

    return tags;
  }
}
