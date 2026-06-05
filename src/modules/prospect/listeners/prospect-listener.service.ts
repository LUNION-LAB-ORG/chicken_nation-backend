import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Customer, EntityStatus, ProspectStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';

/**
 * Avance automatiquement les prospects dans l'entonnoir (cf. cahier §6) :
 *  - `customer.created` (téléphone identique)         → INSCRIT
 *  - `order:created`    (commande payée attribuable)  → CONVERTI + vente
 *
 * Tous les updates utilisent un CLAIM ATOMIQUE (`updateMany` conditionné par le
 * statut) → idempotent et safe même si les DEUX backends tournent en parallèle
 * sur le même Postgres (cf. mémoire « double backend »).
 */
@Injectable()
export class ProspectListenerService {
  private readonly logger = new Logger(ProspectListenerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private last10(phone?: string | null): string | null {
    if (!phone) return null;
    const d = phone.replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d || null;
  }

  @OnEvent('order:created')
  async onOrderCreated(payload: OrderCreatedEvent) {
    try {
      const orderId = payload?.order?.id;
      if (!orderId) return;

      // Re-fetch frais (le payload peut être antérieur à la mise à jour `paied`)
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          code_promo: true,
          phone: true,
          amount: true,
          paied: true,
          customer_id: true,
        },
      });
      if (!order || !order.paied) return; // on n'attribue que des ventes RÉELLES

      // 1) Match fort : le coupon du prospect a été utilisé
      let prospect = order.code_promo
        ? await this.prisma.prospect.findFirst({
            where: {
              promo_code: { code: order.code_promo },
              status: { not: ProspectStatus.CONVERTI },
              entity_status: { not: EntityStatus.DELETED },
            },
          })
        : null;

      // 2) Sinon : commande directe identifiée par le téléphone
      if (!prospect) {
        const phone = this.last10(order.phone);
        if (phone) {
          prospect = await this.prisma.prospect.findFirst({
            where: {
              phone,
              status: { not: ProspectStatus.CONVERTI },
              entity_status: { not: EntityStatus.DELETED },
            },
            orderBy: { created_at: 'asc' },
          });
        }
      }
      if (!prospect) return;

      // Claim atomique
      const res = await this.prisma.prospect.updateMany({
        where: { id: prospect.id, status: { not: ProspectStatus.CONVERTI } },
        data: {
          status: ProspectStatus.CONVERTI,
          converted_at: new Date(),
          first_order_id: order.id,
          first_order_amount: order.amount,
          ...(prospect.customer_id || !order.customer_id
            ? {}
            : { customer_id: order.customer_id }),
        },
      });
      if (res.count > 0) {
        this.logger.log(
          `Prospect ${prospect.id} → CONVERTI via commande ${order.id}`,
        );
      }
    } catch (e) {
      this.logger.warn(`onOrderCreated (prospect) échoué: ${(e as Error)?.message}`);
    }
  }

  @OnEvent('customer.created')
  async onCustomerCreated(payload: { customer: Customer }) {
    try {
      const customer = payload?.customer;
      const phone = this.last10(customer?.phone);
      if (!phone || !customer?.id) return;

      const prospect = await this.prisma.prospect.findFirst({
        where: {
          phone,
          status: { notIn: [ProspectStatus.INSCRIT, ProspectStatus.CONVERTI] },
          entity_status: { not: EntityStatus.DELETED },
        },
        orderBy: { created_at: 'asc' },
      });
      if (!prospect) return;

      const res = await this.prisma.prospect.updateMany({
        where: {
          id: prospect.id,
          status: { notIn: [ProspectStatus.INSCRIT, ProspectStatus.CONVERTI] },
        },
        data: {
          status: ProspectStatus.INSCRIT,
          registered_at: new Date(),
          customer_id: customer.id,
        },
      });
      if (res.count > 0) {
        this.logger.log(
          `Prospect ${prospect.id} → INSCRIT (client ${customer.id})`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `onCustomerCreated (prospect) échoué: ${(e as Error)?.message}`,
      );
    }
  }
}
