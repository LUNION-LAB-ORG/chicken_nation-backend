import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushErrorReceipt, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { SendNotificationDto } from './dto/send-notification.dto';

@Injectable()
export class ExpoPushService {
    private expo: Expo;
    private readonly logger = new Logger(ExpoPushService.name);

    constructor() {
        this.expo = new Expo();
    }

    /**
     * Envoie les notifications en lots (Chunks)
     */
    async sendPushNotifications(payload: SendNotificationDto) {
        const messages: ExpoPushMessage[] = [];

        // 1. Validation et création des messages
        for (const token of payload.tokens) {
            if (!Expo.isExpoPushToken(token)) {
                this.logger.warn(`🚫 Token invalide ignoré: ${token}`);
                continue;
            }

            messages.push({
                to: token,
                sound: (payload.sound as any) || 'default',
                title: payload.title,
                body: payload.body,
                data: payload.data || {},
                subtitle: payload.subtitle,
                badge: payload.badge,
                priority: payload.priority || 'high',
                channelId: payload.channelId || 'default',
            });
        }

        if (messages.length === 0) {
            return { status: 'skipped', message: 'Aucun token valide fourni' };
        }

        // 2. Découpage en lots (Chunks) pour respecter les limites d'Expo
        const chunks = this.expo.chunkPushNotifications(messages);
        const tickets: ExpoPushTicket[] = [];
        const errors: ExpoPushErrorReceipt[] = [];

        // 3. Envoi aux serveurs Expo (Phase 1 : Tickets)
        for (const chunk of chunks) {
            try {
                const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
                tickets.push(...ticketChunk);

                // Vérification immédiate des erreurs d'envoi (ex: quota dépassé)
                ticketChunk.forEach((ticket, index) => {
                    if (ticket.status === 'error') {
                        this.logger.error(`Erreur d'envoi pour un token: ${ticket.message}`);
                        errors.push(ticket);
                    }
                });

            } catch (error) {
                this.logger.error('Erreur critique lors de l\'envoi du chunk', error);
                errors.push(error);
            }
        }

        // 4. (Optionnel) Déclencher la vérification des reçus
        // Note: Idéalement, ceci est fait par un Job (Cron) séparé quelques minutes plus tard.
        // Pour cet exemple, on retourne les IDs des tickets pour info.
        this.processReceiptsAsync(tickets);

        return {
            status: 'processed',
            totalSent: messages.length,
            ticketsReceived: tickets.length,
            errorsCount: errors.length
        };
    }

    /**
     * Phase 2 : Vérification des reçus et Nettoyage DB
     * Cette méthode analyse si Apple/Google a bien livré le message.
     */
    private async processReceiptsAsync(tickets: ExpoPushTicket[]) {
        const receiptIds: string[] = [];

        // On ne garde que les tickets qui ont réussi la phase 1
        for (const ticket of tickets) {
            if (ticket.status === 'ok') {
                receiptIds.push(ticket.id);
            }
        }

        // On découpe les demandes de reçus
        const receiptIdChunks = this.expo.chunkPushNotificationReceiptIds(receiptIds);

        for (const chunk of receiptIdChunks) {
            try {
                // On demande à Expo : "Alors, c'est livré ?"
                const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);

                // Analyse des résultats
                for (const receiptId in receipts) {
                    const { status, message, details } = receipts[receiptId] as any;

                    if (status === 'error') {
                        this.logger.error(`❌ Échec livraison final: ${message}`);

                        // --- POINT CRITIQUE : NETTOYAGE ---
                        if (details && details.error === 'DeviceNotRegistered') {
                            // C'est ici que tu dois appeler ton repository utilisateur
                            this.handleDeviceNotRegistered(message);
                        }
                    }
                }
            } catch (error) {
                this.logger.error(error);
            }
        }
    }

    /**
     * Logique de suppression du token
     */
    private async handleDeviceNotRegistered(errorMessage: string) {
        // TODO: Injecte ton UsersService ou UserRepository ici
        // Exemple : await this.userRepo.removeTokenByError(errorMessage);
        this.logger.warn(`⚠️ ACTION REQUISE : Supprimer le token invalide de la DB. Cause: ${errorMessage}`);
    }
}