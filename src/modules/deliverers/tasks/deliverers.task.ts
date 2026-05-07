import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EntityStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { S3Service } from 'src/s3/s3.service';

/**
 * Tâche cron pour la purge des comptes livreur dont la période de grâce
 * de 90 jours est expirée (suppression programmée par le user lui-même).
 *
 * Fréquence : tous les jours à 03:00 (heure serveur).
 *
 * Comportement :
 *  1. Trouve tous les Deliverer dont `deletion_scheduled_at <= NOW`
 *     ET pas encore en entity_status = DELETED
 *  2. Pour chacun :
 *     - Anonymise les PII (RGPD : nom, email, téléphone, documents)
 *     - Marque entity_status = DELETED
 *     - Tente de supprimer les fichiers S3 (best effort, log si échec)
 *  3. La ligne reste en DB pour préserver l'intégrité référentielle (FK orders).
 *
 * Note : on n'utilise PAS `deleteMany` Prisma — on ne veut PAS hard-delete
 * la ligne (FK ferait casser les courses passées). On anonymise et on flag.
 */
@Injectable()
export class DeliverersTask {
  private readonly logger = new Logger(DeliverersTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredDeletions() {
    const now = new Date();

    const expired = await this.prisma.deliverer.findMany({
      where: {
        deletion_scheduled_at: { lte: now },
        entity_status: { not: EntityStatus.DELETED },
      },
      select: {
        id: true,
        image: true,
        piece_identite: true,
        permis_conduire: true,
      },
    });

    if (expired.length === 0) {
      return;
    }

    this.logger.log(`Purge de ${expired.length} compte(s) livreur expiré(s)`);

    for (const d of expired) {
      try {
        // 1. Tentative de suppression S3 (non bloquante)
        await this.cleanupS3Files(d);

        // 2. Anonymisation + soft delete
        await this.prisma.deliverer.update({
          where: { id: d.id },
          data: {
            entity_status: EntityStatus.DELETED,
            is_operational: false,
            refresh_token: null,
            phone: `deleted-${d.id}`, // libère le numéro original
            email: null,
            first_name: null,
            last_name: null,
            image: null,
            piece_identite: null,
            permis_conduire: null,
          },
        });

        this.logger.log(`Deliverer ${d.id} purgé (anonymisé + DELETED)`);
      } catch (err) {
        this.logger.error(`Échec purge deliverer ${d.id}: ${(err as Error).message}`);
      }
    }
  }

  private async cleanupS3Files(d: {
    image: string | null;
    piece_identite: string | null;
    permis_conduire: string | null;
  }) {
    const keys = [d.image, d.piece_identite, d.permis_conduire].filter(
      (k): k is string => !!k,
    );
    for (const key of keys) {
      try {
        await this.s3Service.deleteFile(key);
      } catch (err) {
        // Best effort : on log mais on continue (peut-être déjà supprimé manuellement)
        this.logger.warn(`S3 delete échoué pour ${key}: ${(err as Error).message}`);
      }
    }
  }
}
