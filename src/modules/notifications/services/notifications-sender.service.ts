import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, PaymentMethod, UserRole } from '@prisma/client';
import { NotificationsTemplate } from '../templates/notifications.template';
import { NotificationsService } from './notifications.service';
import { NotificationsWebSocketService } from '../websockets/notifications-websocket.service';
import { NotificationRecipientService } from '../recipients/notification-recipient.service';
import { NotificationTemplate, NotificationRecipient } from '../interfaces/notifications.interface';
import { getOrderNotificationContent } from 'src/modules/order/constantes/order-notifications.constante';
import { PrismaService } from 'src/database/services/prisma.service';
import { EmailService } from './email.service';

@Injectable()
export class NotificationsSenderService {
    private readonly logger = new Logger(NotificationsSenderService.name);

    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsService: NotificationsService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly prisma: PrismaService,
        private readonly emailService: EmailService,
    ) { }

    /**
     * Gère les notifications de paiement
     */
    async handlePaymentCompleted(payment: any, order: any, customer: any) {
        const customerRecipient = await this.notificationRecipientService.getCustomer(customer.id);
        if (!customerRecipient) return;

        const restaurantUsers = await this.notificationRecipientService.getAllUsersByRestaurantAndRole(order.restaurant_id);

        const paymentData = {
            reference: order.reference,
            amount: payment.amount,
            mode: payment.mode
        };

        const actor = customerRecipient;

        // Notification au client
        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.PAYMENT_SUCCESS_CUSTOMER,
            { actor, recipients: [customerRecipient], data: paymentData },
            NotificationType.ORDER
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], actor);

        // Notification au restaurant
        if (restaurantUsers.length > 0) {
            const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplate.PAYMENT_SUCCESS_RESTAURANT,
                { actor, recipients: restaurantUsers, data: paymentData },
                NotificationType.ORDER
            );
            this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0]);
        }
    }

    /**
     * Notification CLOCHE « commande » au staff du restaurant (caisse / manager /
     * assistant-manager). Réutilise les contenus riches par statut de
     * getOrderNotificationContent. Persiste 1 ligne/destinataire + diffuse en temps
     * réel à la room du restaurant (event `notification:new` → cloche + bip).
     * `order` doit porter : id, reference, status, amount, restaurant_id, restaurant?.name,
     * fullname, payment_method.
     */
    async sendOrderBell(order: any) {
        if (!order?.restaurant_id) return;

        const recipients = await this.notificationRecipientService.getAllUsersByRestaurantAndRole(
            order.restaurant_id,
            [UserRole.CAISSIER, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER],
        );
        if (recipients.length === 0) return;

        const content = getOrderNotificationContent(
            {
                reference: order.reference,
                status: order.status,
                amount: order.amount ?? 0,
                restaurant_name: order.restaurant?.name ?? '',
                customer_name: order.fullname ?? 'Client',
                payment_method: order.payment_method ?? PaymentMethod.ONLINE,
            },
            'restaurant',
        );

        // getOrderNotificationContent renvoie un objet PLAT ; le template attend des fonctions.
        const template: NotificationTemplate<any> = {
            title: () => content.title,
            message: () => content.message,
            icon: () => content.icon,
            iconBgColor: () => content.iconBgColor,
        };

        const notifications = await this.notificationsService.sendNotificationToMultiple(
            template,
            {
                actor: recipients[0],
                recipients,
                data: order,
                meta: { order_id: order.id, reference: order.reference, status: order.status },
            },
            NotificationType.ORDER,
        );
        // group=true → broadcast à la room restaurant_{id} (le client invalide sur notification:new).
        this.notificationsWebSocketService.emitNotification(notifications[0], recipients[0], true);
    }

    /**
     * Notifie le STAFF (cloche in-app + email) qu'un CLIENT a écrit un nouveau
     * message. Destinataires = staff du restaurant concerné + tout le back office.
     * Chaque canal est filtré par la préférence du membre
     * (in_app_notifications_enabled / email_notifications_enabled). L'email et la
     * cloche portent un deep-link vers la conversation (`data.deep_link`).
     */
    async notifyStaffNewMessage(params: {
        conversationId: string;
        restaurantId?: string | null;
        customerId?: string | null;
        preview: string;
    }) {
        const { conversationId, restaurantId, customerId, preview } = params;

        const [restoUsers, backofficeUsers, customer, restaurant] = await Promise.all([
            restaurantId
                ? this.notificationRecipientService.getAllUsersByRestaurantAndRole(restaurantId)
                : Promise.resolve([] as NotificationRecipient[]),
            this.notificationRecipientService.getAllUsersByBackofficeAndRole(),
            customerId
                ? this.prisma.customer.findUnique({
                      where: { id: customerId },
                      select: { first_name: true, last_name: true },
                  })
                : Promise.resolve(null),
            restaurantId
                ? this.prisma.restaurant.findUnique({
                      where: { id: restaurantId },
                      select: { name: true },
                  })
                : Promise.resolve(null),
        ]);

        // Dédupe par id (un user est BACKOFFICE ou RESTAURANT, mais garde-fou).
        const byId = new Map<string, NotificationRecipient>();
        for (const r of [...restoUsers, ...backofficeUsers]) byId.set(r.id, r);
        const recipients = [...byId.values()];
        if (recipients.length === 0) return;

        const senderName =
            `${customer?.first_name ?? ''} ${customer?.last_name ?? ''}`.trim() || 'Un client';
        const safePreview = (preview || '').trim().substring(0, 200) || 'Nouveau message';
        const deepLinkPath = `/gestion?module=inbox&conversation=${conversationId}`;
        // `data` alimente le rendu du template (title/message).
        const templateData = { senderName, preview: safePreview, conversationId };
        // `meta` est ce qui est PERSISTÉ dans Notification.data (cf. notifications.service:281)
        // et émis en temps réel → c'est là que doit vivre le payload de navigation
        // consommé par le front (toast/cloche → deep-link conversation).
        const navMeta = {
            kind: 'new_message',
            conversationId,
            restaurantId: restaurantId ?? undefined,
            deep_link: deepLinkPath,
        };

        // --- Cloche in-app : uniquement les membres qui l'acceptent ---
        const inAppRecipients = recipients.filter((r) => r.in_app_notifications_enabled !== false);
        if (inAppRecipients.length > 0) {
            const notifications = await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplate.NEW_MESSAGE_STAFF,
                {
                    actor: inAppRecipients[0],
                    recipients: inAppRecipients,
                    data: templateData,
                    meta: navMeta,
                },
                NotificationType.SYSTEM,
            );
            // Emit CIBLÉ par utilisateur : seuls les opt-in reçoivent le socket
            // (une diffusion de groupe toucherait aussi les membres opt-out).
            notifications.forEach((notif, i) => {
                this.notificationsWebSocketService.emitNotification(notif, inAppRecipients[i]);
            });
        }

        // --- Email : uniquement les membres qui l'acceptent + email présent ---
        const emailRecipients = recipients.filter(
            (r) => r.email_notifications_enabled !== false && !!r.email,
        );
        if (emailRecipients.length > 0) {
            const url = `${this.backofficeUrl()}${deepLinkPath}`;
            const html = this.buildNewMessageEmail({
                senderName,
                preview: safePreview,
                restaurantName: restaurant?.name ?? null,
                url,
            });
            await this.emailService
                .sendMail({
                    to: emailRecipients.map((r) => r.email as string),
                    subject: `Nouveau message de ${senderName}`,
                    html,
                })
                .catch((e) => this.logger.warn(`Email « nouveau message » échoué: ${e?.message}`));
        }
    }

    private backofficeUrl(): string {
        return (process.env.BACKOFFICE_URL || 'https://admin-private.chicken-nation.com').replace(
            /\/$/,
            '',
        );
    }

    private buildNewMessageEmail(p: {
        senderName: string;
        preview: string;
        restaurantName: string | null;
        url: string;
    }): string {
        const esc = (s: string) =>
            String(s ?? '').replace(
                /[&<>"]/g,
                (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
            );
        return `<!DOCTYPE html><html lang="fr"><body style="margin:0;background:#f5f6f8;font-family:'Segoe UI',Tahoma,sans-serif;color:#1f2430;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:linear-gradient(135deg,#F17922,#d94f00);border-radius:14px 14px 0 0;padding:22px 26px;">
      <div style="color:#fff;font-size:19px;font-weight:800;">Chicken Nation</div>
      <div style="color:rgba(255,255,255,.9);font-size:13px;margin-top:2px;">Nouveau message client</div>
    </div>
    <div style="background:#fff;border:1px solid #eceff2;border-top:none;border-radius:0 0 14px 14px;padding:24px 26px;">
      <p style="font-size:14px;line-height:1.6;margin:0 0 14px;">
        <strong>${esc(p.senderName)}</strong> vous a envoyé un message${p.restaurantName ? ` (${esc(p.restaurantName)})` : ''} :
      </p>
      <div style="background:#faf7f4;border:1px solid #efe6dd;border-radius:10px;padding:12px 14px;font-size:14px;color:#444;margin-bottom:20px;">
        ${esc(p.preview)}
      </div>
      <a href="${p.url}" style="display:inline-block;background:#F17922;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;">Répondre dans le backoffice</a>
      <p style="font-size:11px;color:#8a93a2;margin-top:20px;">
        Vous recevez cet email car les alertes par email sont activées sur votre profil. Vous pouvez les désactiver dans « Modifier le profil ».
      </p>
    </div>
  </div>
</body></html>`;
    }
}