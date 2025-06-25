import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LoyaltyLevel, NotificationType, UserType } from '@prisma/client'; // Import UserType
import { IEmailService } from 'src/modules/email/interfaces/email-service.interface';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';

import { PromotionManagementEventPayload, PromotionUsedEventPayload } from '../interfaces/promotion.interface';

// Import Promotion Templates
import { PromotionEmailTemplates } from '../templates/promotion-email.template';
import { PromotionNotificationsTemplate } from '../templates/promotion-notifications.template';

@Injectable()
export class PromotionListenerService {
    constructor(
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,

        private readonly promotionEmailTemplates: PromotionEmailTemplates,
        private readonly promotionNotificationsTemplate: PromotionNotificationsTemplate,
    ) { }

    /**
     * Handles the 'promotion.used' event.
     * Notifies the customer about their successful promotion usage.
     */
    @OnEvent('promotion.used')
    async handlePromotionUsedEvent(payload: PromotionUsedEventPayload) {
        // --- Recipients ---
        const customer = await this.notificationRecipientService.getCustomer(payload.customer.id);
        const customerEmail: string[] = customer.email ? [customer.email] : [];

        // --- Emails ---
        if (customerEmail.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.promotionEmailTemplates.PROMOTION_USED_CUSTOMER,
                {
                    recipients: customerEmail,
                    data: {
                        customer: payload.customer,
                        promotion: payload.promotion,
                        discountAmount: payload.discountAmount,
                    },
                },
            );
        }

        // --- Notifications ---
        const notificationDataCustomer = {
            actor: customer,
            recipients: [customer],
            data: {
                customer: payload.customer,
                promotion: payload.promotion,
                discountAmount: payload.discountAmount,
            },
        };

        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.promotionNotificationsTemplate.PROMOTION_USED,
            notificationDataCustomer,
            NotificationType.PROMOTION
        );

        // Notify in real-time if a notification was created for the customer
        if (notificationCustomer.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);
        }
    }

    /**
     * Handles 'promotion.created' event.
     * Notifies customers (if public), back-office, and restaurant managers.
     */
    @OnEvent('promotion.created')
    async handlePromotionCreatedEvent(payload: PromotionManagementEventPayload) {
        // --- Recipients ---
        const backofficeUsers = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const restaurantManagers = await this.notificationRecipientService.getAllManagers();
        const allCustomers = await this.notificationRecipientService.getAllCustomers();

        const backofficeEmails: string[] = backofficeUsers.map(u => u.email).filter(Boolean) as string[];
        const restaurantManagerEmails: string[] = restaurantManagers.map(u => u.email).filter(Boolean) as string[];
        const customerEmails: string[] = allCustomers.map(c => c.email).filter(Boolean) as string[];

        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);
        // --- Emails ---
        // 1. Email to Back-Office & Restaurant Managers (Internal)
        const internalRecipientsEmails = [...new Set([...backofficeEmails, ...restaurantManagerEmails])];
        if (internalRecipientsEmails.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.promotionEmailTemplates.PROMOTION_CREATED_INTERNAL,
                {
                    recipients: internalRecipientsEmails,
                    data: {
                        actor: payload.actor,
                        promotion: payload.promotion,
                    },
                },
            );
        }

        // 2. Email to Customers (if promotion is public)
        if (payload.promotion.visibility === 'PUBLIC' && customerEmails.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.promotionEmailTemplates.NEW_PROMOTION_AVAILABLE_CUSTOMER,
                {
                    recipients: customerEmails,
                    data: {
                        actor: payload.actor,
                        promotion: payload.promotion,
                        targetedNames: payload.targetedNames,
                    },
                },
            );
        }
        if (payload.promotion.visibility !== 'PUBLIC' && allCustomers.length > 0) {

            const targetedCustomers = allCustomers.filter(c => payload.promotion.target_standard && c.loyalty_level === LoyaltyLevel.STANDARD || payload.promotion.target_premium && c.loyalty_level === LoyaltyLevel.PREMIUM || payload.promotion.target_gold && c.loyalty_level === LoyaltyLevel.GOLD);

            const targetedCustomersEmails: string[] = targetedCustomers.map(c => c.email).filter(Boolean) as string[];

            if (targetedCustomersEmails.length > 0) {
                await this.emailService.sendEmailTemplate(
                    this.promotionEmailTemplates.NEW_PROMOTION_AVAILABLE_CUSTOMER,
                    {
                        recipients: targetedCustomersEmails,
                        data: {
                            actor: payload.actor,
                            promotion: payload.promotion,
                            targetedNames: payload.targetedNames,
                        },
                    },
                );
            }
        }

        // --- Notifications ---
        // 1. Notification to Back-Office (Internal)
        const notificationDataBackoffice = {
            actor: actorRecipient,
            recipients: backofficeUsers,
            data: payload,
        };
        const backofficeNotifications = await this.notificationsService.sendNotificationToMultiple(
            this.promotionNotificationsTemplate.PROMOTION_CREATED_INTERNAL,
            notificationDataBackoffice,
            NotificationType.PROMOTION
        );
        backofficeNotifications.forEach(notif => {
            const recipientUser = backofficeUsers.find(u => u.id === notif.user_id);
            if (recipientUser) {
                this.notificationsWebSocketService.emitNotification(notif, recipientUser);
            }
        });

        // 2. Notification to Restaurant Managers (Internal)
        const notificationDataRestaurantManagers = {
            actor: actorRecipient,
            recipients: restaurantManagers,
            data: payload,
        };
        const managerNotifications = await this.notificationsService.sendNotificationToMultiple(
            this.promotionNotificationsTemplate.PROMOTION_CREATED_INTERNAL,
            notificationDataRestaurantManagers,
            NotificationType.PROMOTION
        );
        managerNotifications.forEach(notif => {
            const recipientUser = restaurantManagers.find(u => u.id === notif.user_id);
            if (recipientUser) {
                this.notificationsWebSocketService.emitNotification(notif, recipientUser);
            }
        });

        // 3. Notification to Customers (if promotion is public)
        if (payload.promotion.visibility === 'PUBLIC') {
            const notificationDataCustomers = {
                actor: actorRecipient,
                recipients: allCustomers,
                data: payload,
            };
            const customerNotifications = await this.notificationsService.sendNotificationToMultiple(
                this.promotionNotificationsTemplate.PROMOTION_AVAILABLE,
                notificationDataCustomers,
                NotificationType.PROMOTION
            );
            customerNotifications.forEach(notif => {
                const recipientCustomer = allCustomers.find(c => c.id === notif.user_id);
                if (recipientCustomer) {
                    this.notificationsWebSocketService.emitNotification(notif, recipientCustomer);
                }
            });
        } else {
            const targetedCustomers = allCustomers.filter(c => payload.promotion.target_standard && c.loyalty_level === LoyaltyLevel.STANDARD || payload.promotion.target_premium && c.loyalty_level === LoyaltyLevel.PREMIUM || payload.promotion.target_gold && c.loyalty_level === LoyaltyLevel.GOLD);
            const notificationDataCustomers = {
                actor: actorRecipient,
                recipients: targetedCustomers,
                data: payload,
            };
            const customerNotifications = await this.notificationsService.sendNotificationToMultiple(
                this.promotionNotificationsTemplate.PROMOTION_AVAILABLE,
                notificationDataCustomers,
                NotificationType.PROMOTION
            );
            customerNotifications.forEach(notif => {
                const recipientCustomer = targetedCustomers.find(c => c.id === notif.user_id);

                if (recipientCustomer) {
                    this.notificationsWebSocketService.emitNotification(notif, recipientCustomer);
                }
            });
        }
    }

    /**
     * Handles 'promotion.updated' event.
     * Notifies back-office and restaurant managers about the update.
     */
    @OnEvent('promotion.updated')
    async handlePromotionUpdatedEvent(payload: PromotionManagementEventPayload) {
        // --- Recipients ---
        const backofficeUsers = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const restaurantManagers = await this.notificationRecipientService.getAllManagers();

        const backofficeEmails: string[] = backofficeUsers.map(u => u.email).filter(Boolean) as string[];
        const restaurantManagerEmails: string[] = restaurantManagers.map(u => u.email).filter(Boolean) as string[];

        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // --- Emails ---
        const internalRecipientsEmails = [...new Set([...backofficeEmails, ...restaurantManagerEmails])];
        if (internalRecipientsEmails.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.promotionEmailTemplates.PROMOTION_UPDATED_INTERNAL,
                {
                    recipients: internalRecipientsEmails,
                    data: {
                        actor: payload.actor,
                        promotion: payload.promotion,
                    },
                },
            );
        }

        // --- Notifications ---
        const notificationDataInternal = {
            actor: actorRecipient,
            recipients: [...backofficeUsers, ...restaurantManagers],
            data: payload,
        };
        const internalNotifications = await this.notificationsService.sendNotificationToMultiple(
            this.promotionNotificationsTemplate.PROMOTION_UPDATED_INTERNAL,
            notificationDataInternal,
            NotificationType.PROMOTION
        );
        internalNotifications.forEach(notif => {
            const recipientUser = [...backofficeUsers, ...restaurantManagers].find(u => u.id === notif.user_id);
            if (recipientUser) {
                this.notificationsWebSocketService.emitNotification(notif, recipientUser);
            }
        });
    }

    /**
     * Handles 'promotion.deleted' event.
     * Notifies back-office and restaurant managers about the deletion.
     */
    @OnEvent('promotion.deleted')
    async handlePromotionDeletedEvent(payload: PromotionManagementEventPayload) {
        // --- Recipients ---
        const backofficeUsers = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const restaurantManagers = await this.notificationRecipientService.getAllManagers();

        const backofficeEmails: string[] = backofficeUsers.map(u => u.email).filter(Boolean) as string[];
        const restaurantManagerEmails: string[] = restaurantManagers.map(u => u.email).filter(Boolean) as string[];

        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // --- Emails ---
        const internalRecipientsEmails = [...new Set([...backofficeEmails, ...restaurantManagerEmails])];
        if (internalRecipientsEmails.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.promotionEmailTemplates.PROMOTION_DELETED_INTERNAL,
                {
                    recipients: internalRecipientsEmails,
                    data: {
                        actor: payload.actor,
                        promotion: payload.promotion,
                    },
                },
            );
        }

        // --- Notifications ---
        const notificationDataInternal = {
            actor: actorRecipient,
            recipients: [...backofficeUsers, ...restaurantManagers],
            data: payload,
        };
        const internalNotifications = await this.notificationsService.sendNotificationToMultiple(
            this.promotionNotificationsTemplate.PROMOTION_DELETED_INTERNAL,
            notificationDataInternal,
            NotificationType.PROMOTION
        );
        internalNotifications.forEach(notif => {
            const recipientUser = [...backofficeUsers, ...restaurantManagers].find(u => u.id === notif.user_id);
            if (recipientUser) {
                this.notificationsWebSocketService.emitNotification(notif, recipientUser);
            }
        });
    }
}