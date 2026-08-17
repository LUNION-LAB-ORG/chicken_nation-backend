import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { TwilioService } from 'src/twilio/services/twilio.service';

/**
 * DÉPART DU LIVREUR : prévient le client et lui donne son code de récupération.
 *
 * Vit dans le module commun, et non dans le module des commandes, parce que
 * deux chemins de livraison l'appellent : la flotte interne et Turbo. Le loger
 * dans le module des commandes obligerait ces deux modules à en dépendre, alors
 * qu'il ne fait que lire une commande et envoyer un message.
 *
 * Sans état : deux instances se comportent exactement pareil.
 */
@Injectable()
export class OrderDepartureNotifierService {
  private readonly logger = new Logger(OrderDepartureNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) { }

  /**
   * Ne lève JAMAIS : un message qui échoue ne doit pas faire échouer le départ
   * d'une livraison, ni un accusé de réception de webhook Turbo.
   */
  async notifier(orderId: string): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          reference: true,
          phone: true,
          fullname: true,
          recovery_code: true,
          customer_id: true,
          // La livraison porte le code réellement exigé par le livreur. Il
          // vaut celui de la commande depuis le 12/08, mais une livraison
          // antérieure peut en avoir un autre : c'est CELUI-LÀ qu'il faut
          // annoncer, sinon le client dicterait un code refusé.
          delivery: { select: { delivery_pin: true } },
        },
      });
      if (!order?.customer_id || !order.phone) return;

      const code = order.delivery?.delivery_pin ?? order.recovery_code ?? '';
      // Mieux vaut ne rien envoyer qu'un message annonçant un code vide : le
      // client appellerait le support pour un message qui ne lui sert à rien.
      if (!code) {
        this.logger.warn(
          `Départ livreur : aucun code de récupération pour la commande ${orderId}, message non envoyé`,
        );
        return;
      }

      // Le client qui a l'application voit son code à l'écran : lui écrire en
      // plus serait redondant, et coûterait un message à chaque livraison.
      const notif = await this.prisma.notificationSetting.findUnique({
        where: { customer_id: order.customer_id },
        select: { expo_push_token: true, onesignal_id: true },
      });
      if (notif?.expo_push_token || notif?.onesignal_id) return;

      await this.twilioService.sendOrderTracking({
        phoneNumber: order.phone,
        customerName: order.fullname || 'Client',
        orderReference: order.reference || '',
        recoveryCode: code,
      });
    } catch (err: any) {
      this.logger.error(
        `Départ livreur, message non envoyé pour la commande ${orderId} : ${err?.message ?? err}`,
      );
    }
  }
}
