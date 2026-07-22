import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType, Prisma, RewardStatus, RewardType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { CUSTOMER_EVENTS } from '../contantes/customer-events.contante';
import { CustomerNotificationsTemplate } from '../templates/customer-notifications.template';

/** Motif UNIQUE du bon de bienvenue — sert aussi de garde d'idempotence. */
const WELCOME_GIFT_REASON = 'Bon de bienvenue 🎁';

@Injectable()
export class CustomerListenerService {
    private readonly logger = new Logger(CustomerListenerService.name);

    constructor(
        private readonly customerNotificationsTemplate: CustomerNotificationsTemplate,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
        private readonly prisma: PrismaService,
        private readonly settingsService: SettingsService,
    ) { }

    /**
     * Bon de bienvenue UNIVERSEL (cadeau à gratter) pour TOUT nouvel inscrit,
     * même sans code de parrainage. Montant paramétrable au backoffice
     * (`reward.welcome.amount`, défaut 500 F, 0 = désactivé). Idempotent par
     * client (garde sur le motif). Retourne le montant accordé, sinon null.
     */
    private async grantWelcomeGift(customerId: string): Promise<number | null> {
        try {
            const raw = await this.settingsService.get('reward.welcome.amount');
            const amount = raw === null || raw.trim() === '' ? 500 : Number(raw);
            if (!Number.isFinite(amount) || amount <= 0) return null;

            const already = await this.prisma.reward.findFirst({
                where: { customer_id: customerId, reason: WELCOME_GIFT_REASON },
                select: { id: true },
            });
            if (already) return null;

            // Créateur système des bons (Voucher.created_by non nullable au grattage).
            const configured = await this.settingsService.get('reward.referral.created_by');
            let creatorId: string | null = null;
            if (configured) {
                const u = await this.prisma.user.findUnique({ where: { id: configured }, select: { id: true } });
                creatorId = u?.id ?? null;
            }
            if (!creatorId) {
                const first = await this.prisma.user.findFirst({ orderBy: { created_at: 'asc' }, select: { id: true } });
                creatorId = first?.id ?? null;
            }
            if (!creatorId) {
                this.logger.warn('Bon de bienvenue : aucun créateur système → non créé.');
                return null;
            }

            await this.prisma.reward.create({
                data: {
                    customer_id: customerId,
                    type: RewardType.VOUCHER,
                    payload: { amount, created_by: creatorId } as Prisma.InputJsonValue,
                    reason: WELCOME_GIFT_REASON,
                    status: RewardStatus.PENDING,
                },
            });
            return amount;
        } catch (e: any) {
            this.logger.warn(`Bon de bienvenue non créé (${customerId}) : ${e?.message}`);
            return null;
        }
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_CREATED)
    async customerCreatedEventListener(payload: { customer: any }) {
        // Récupérer les administrateurs/backoffice — en respectant la préférence
        // in-app de chaque membre (opt-out => ni persistance ni socket).
        const admins = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const adminsFiltered = admins.filter(
            (u) => u.email !== payload.customer.email && u.in_app_notifications_enabled !== false,
        );

        // Préparer destinataire client
        const customerRecipient = this.notificationRecipientService.mapCustomerToNotificationRecipient(payload.customer);

        // Notifications aux admins
        if (adminsFiltered.length > 0) {
            const fullname = `${payload.customer.first_name ?? ''} ${payload.customer.last_name ?? ''}`.trim();
            const notificationsAdmin = await this.notificationsService.sendNotificationToMultiple(
                this.customerNotificationsTemplate.NEW_CUSTOMER,
                {
                    actor: customerRecipient,
                    recipients: adminsFiltered,
                    data: payload,
                    // Persisté dans Notification.data → payload de navigation du front
                    // (clic cloche → page Clients filtrée sur ce client).
                    meta: {
                        kind: 'new_customer',
                        customer_id: payload.customer.id,
                        search: fullname || payload.customer.phone || '',
                    },
                },
                NotificationType.SYSTEM
            );
            // Emit CIBLÉ par admin (1 notification ↔ 1 destinataire). L'ancien code
            // broadcastait `group=true` DANS la boucle → la room backoffice recevait
            // N fois le même event (doublons visuels + N bips).
            notificationsAdmin.forEach((notif, i) => {
                this.notificationsWebSocketService.emitNotification(notif, adminsFiltered[i]);
            });
        }

        // 🎁 Bon de bienvenue UNIVERSEL (même sans code de parrainage).
        // Créé AVANT la notification pour que celle-ci puisse l'annoncer.
        const welcomeAmount = await this.grantWelcomeGift(payload.customer.id);

        // Notification au client
        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.customerNotificationsTemplate.WELCOME_CUSTOMER,
            {
                actor: customerRecipient,
                recipients: [customerRecipient],
                data: { ...payload, welcome_amount: welcomeAmount },
            },
            NotificationType.SYSTEM
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], customerRecipient);
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_ACTIVATED)
    async customerActivatedEventListener(payload: { customer: any }) {
        // TODO: envoi email + notifications pour l’activation
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_DEACTIVATED)
    async customerDeactivatedEventListener(payload: { customer: any }) {
        // TODO: envoi email + notifications pour la désactivation
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_DELETED)
    async customerDeletedEventListener(payload: { customer: any }) {
        // TODO: envoi email + notifications pour la suppression
    }
}
