import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { OrderService } from '../services/order.service';
import { OrderStatus, PaiementStatus, PaymentMethod } from '@prisma/client';
import { KkiapayOrderListenerService } from '../listeners/kkiapay-order.listener.service';

@Injectable()
export class OrderTask {
  private readonly logger = new Logger(OrderTask.name);

  constructor(
    private orderService: OrderService,
    private prisma: PrismaService,
    private readonly kkiapayListener: KkiapayOrderListenerService,
  ) { }

  /**
   * FILET DE RÉCONCILIATION KKiaPay (revue 31/07 — ce cron était promis par le
   * listener mais restait VIDE) : rattrape les commandes en ligne payées dont la
   * confirmation a échoué après épuisement des retries BullMQ (~85 min) ou dont
   * le claim a raté (Paiement SUCCESS enregistré mais commande restée PENDING).
   *
   * Périmètre VOLONTAIREMENT borné : commandes ONLINE / PENDING / non payées,
   * âgées de 5 min à 24 h, possédant AU MOINS un Paiement SUCCESS — le
   * transactionId est alors connu (référence du paiement) et on REJOUE le chemin
   * webhook complet (processTransactionSuccess), idempotent par construction
   * (dedupeByReference + claim atomique PENDING→ACCEPTED + effets idempotents).
   *
   * Double backend : AUCUN claim préalable nécessaire — tout le chemin rejoué
   * est déjà à claims atomiques, une exécution concurrente est un no-op.
   * Désactivable par DISABLE_KKIAPAY_RECONCILE_CRON=true (2e backend).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async updateOrders() {
    if (process.env.DISABLE_KKIAPAY_RECONCILE_CRON === 'true') return;

    const now = Date.now();
    const candidates = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        paied: false,
        payment_method: PaymentMethod.ONLINE,
        created_at: {
          gte: new Date(now - 24 * 60 * 60 * 1000),
          lte: new Date(now - 5 * 60 * 1000),
        },
        paiements: { some: { status: PaiementStatus.SUCCESS } },
      },
      select: {
        id: true,
        reference: true,
        paiements: {
          where: { status: PaiementStatus.SUCCESS },
          select: { reference: true, restaurant_id: true },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      take: 20, // borne par passage : le cron repasse toutes les 5 min
    });

    for (const order of candidates) {
      const paiement = order.paiements[0];
      if (!paiement?.reference) continue;
      try {
        const result = await this.kkiapayListener.processTransactionSuccess({
          event: 'transaction.success',
          transactionId: paiement.reference,
          stateData: order.reference,
          restaurantId: paiement.restaurant_id ?? undefined,
        } as any);
        if (result?.confirmed) {
          this.logger.log(
            `Réconciliation KKiaPay : commande ${order.reference} confirmée depuis le paiement ${paiement.reference}.`,
          );
        }
      } catch (e) {
        // Erreur transitoire (Neon/KKiaPay indisponible) : on n'insiste pas,
        // le prochain passage du cron réessaiera.
        this.logger.warn(
          `Réconciliation KKiaPay : échec transitoire sur ${order.reference} : ${(e as any)?.message}`,
        );
      }
    }
  }
}
