import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';

/**
 * CRON — Nettoyage automatique des comptes clients incomplets
 *
 * Tourne chaque nuit à 2h du matin (Africa/Abidjan).
 * Supprime les clients qui :
 *   - N'ont pas de profil complet (first_name, last_name ou email manquant)
 *   - N'ont jamais passé de commande
 */
@Injectable()
export class CustomerCleanupTask {
  private readonly logger = new Logger(CustomerCleanupTask.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 2 * * *', { timeZone: 'Africa/Abidjan' })
  async cleanupIncompleteProfiles() {
    this.logger.log('Début du nettoyage des profils incomplets sans commande...');

    try {
      // Identifier les clients à supprimer
      const toDelete = await this.prisma.customer.findMany({
        where: {
          first_name: null,
          last_name: null,
          orders: { none: {} },
        },
        select: { id: true, phone: true },
      });

      if (toDelete.length === 0) {
        this.logger.log('Aucun profil incomplet sans commande à nettoyer.');
        return;
      }

      const ids = toDelete.map((c) => c.id);

      // Supprimer les données liées puis les clients (dans une transaction)
      const result = await this.prisma.$transaction([
        this.prisma.notificationSetting.deleteMany({
          where: { customer_id: { in: ids } },
        }),
        this.prisma.address.deleteMany({
          where: { customer_id: { in: ids } },
        }),
        this.prisma.favorite.deleteMany({
          where: { customer_id: { in: ids } },
        }),
        this.prisma.loyaltyPoint.deleteMany({
          where: { customer_id: { in: ids } },
        }),
        this.prisma.customer.deleteMany({
          where: { id: { in: ids } },
        }),
      ]);

      const deletedCount = result[result.length - 1].count;
      this.logger.log(
        `Nettoyage terminé : ${deletedCount} profil(s) incomplet(s) supprimé(s).`,
      );
    } catch (error) {
      this.logger.error(
        `Erreur lors du nettoyage des profils incomplets: ${error.message}`,
        error.stack,
      );
    }
  }
}
