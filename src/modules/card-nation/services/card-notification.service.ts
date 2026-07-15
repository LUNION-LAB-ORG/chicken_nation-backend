import { Injectable, Logger } from '@nestjs/common';
import { LoyaltyLevel, NotificationType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { CardNotificationsTemplate } from '../templates/card-notifications.template';

/**
 * Notifications de la Carte de la Nation (Phase 3) : cloche (persistée) + WS + push Expo.
 *
 * Toutes les méthodes sont BEST-EFFORT : une panne notification ne doit jamais
 * faire échouer l'émission ou la régénération d'une carte (l'appelant catch/log).
 */
@Injectable()
export class CardNotificationService {
  private readonly logger = new Logger(CardNotificationService.name);

  private static readonly LEVEL_LABEL: Record<LoyaltyLevel, string> = {
    STANDARD: 'Standard',
    VIP: 'VIP',
    VVIP: 'VVIP',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPushService: ExpoPushService,
    private readonly notificationsService: NotificationsService,
    private readonly notificationRecipientService: NotificationRecipientService,
    private readonly notificationsWebSocketService: NotificationsWebSocketService,
  ) {}

  private levelLabel(level?: LoyaltyLevel | null): string | null {
    return level ? CardNotificationService.LEVEL_LABEL[level] ?? null : null;
  }

  /**
   * Notifie la RÉCEPTION d'une demande de carte (cloche + WS + push) — AVANT
   * toute validation backoffice. La carte n'est PAS encore émise ici.
   */
  async notifyRequestReceived(customerId: string): Promise<void> {
    await this.dispatch(
      customerId,
      CardNotificationsTemplate.CARD_REQUEST_RECEIVED,
      null,
      {
        title: '📨 Demande de carte reçue',
        body: 'Ta demande de carte est bien reçue, on la valide très vite.',
        data: { type: 'card_nation_request_received' },
      },
    );
  }

  /** Notifie l'émission d'une carte (cloche + WS + push). */
  async notifyCardReady(customerId: string, level?: LoyaltyLevel | null): Promise<void> {
    await this.dispatch(
      customerId,
      CardNotificationsTemplate.CARD_READY,
      this.levelLabel(level),
      {
        title: '🎉 Votre Carte de la Nation est prête !',
        body: "Votre carte vient d'être émise. Retrouvez-la dans l'application.",
        data: { type: 'card_nation_ready' },
      },
    );
  }

  /** Notifie la mise à jour de la carte suite à un changement de niveau. */
  async notifyCardLevelChanged(customerId: string, level?: LoyaltyLevel | null): Promise<void> {
    const label = this.levelLabel(level);
    await this.dispatch(
      customerId,
      CardNotificationsTemplate.CARD_LEVEL_CHANGED,
      label,
      {
        title: `✨ Votre carte passe au niveau ${label ?? ''} !`,
        body: "Votre Carte de la Nation a un nouveau design. Découvrez-la dans l'application.",
        data: { type: 'card_nation_level_changed', level },
      },
    );
  }

  /**
   * Mutualise l'envoi : notification cloche persistée + WS temps réel + push Expo.
   * Le WhatsApp « carte prête » (template Meta approuvé) part séparément à la VALIDATION
   * backoffice (card-request.service.reviewRequest → twilioService.sendCardReady).
   */
  private async dispatch(
    customerId: string,
    template: any,
    level: string | null,
    push: { title: string; body: string; data: Record<string, any> },
  ): Promise<void> {
    try {
      const recipient = await this.notificationRecipientService.getCustomer(customerId);

      // Cloche persistée + WS
      const notifications = await this.notificationsService.sendNotificationToMultiple(
        template,
        {
          actor: recipient,
          recipients: [recipient],
          data: { first_name: recipient.name, level },
        },
        NotificationType.SYSTEM,
      );
      if (notifications.length > 0) {
        this.notificationsWebSocketService.emitNotification(notifications[0], recipient);
      }

      // Push Expo (best-effort) — le token client est porté par notification_settings.
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { notification_settings: { select: { expo_push_token: true } } },
      });
      const expoToken = customer?.notification_settings?.expo_push_token;
      if (expoToken) {
        await this.expoPushService.sendPushNotifications({
          tokens: [expoToken],
          title: push.title,
          body: push.body,
          data: push.data,
          sound: 'default',
          priority: 'high',
          channelId: 'default',
        });
      }
    } catch (error) {
      this.logger.warn(
        `Notification carte (client ${customerId}) échouée (best-effort) : ${(error as Error)?.message}`,
      );
    }
  }
}
