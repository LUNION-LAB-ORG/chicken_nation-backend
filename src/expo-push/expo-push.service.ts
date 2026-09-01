import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushErrorReceipt, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { SendNotificationDto } from './dto/send-notification.dto';
import { PrismaService } from 'src/database/services/prisma.service';

@Injectable()
export class ExpoPushService {
    private expo: Expo;
    private readonly logger = new Logger(ExpoPushService.name);

    constructor(private readonly prisma: PrismaService) {
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
                // categoryId : permet à iOS/Android d'attacher les boutons
                // d'action (ex: "Accepter" / "Refuser" pour new_course_offer).
                // Le mobile doit avoir préalablement enregistré la catégorie
                // via Notifications.setNotificationCategoryAsync.
                categoryId: payload.categoryId,
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
        const recus: { id: string; token: string }[] = [];
        for (const chunk of chunks) {
            try {
                const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);

                /**
                 * ⚠️ L'appariement ticket vers jeton se fait ICI, à l'intérieur
                 * du lot, et surtout PAS après coup sur un tableau global.
                 *
                 * Expo rend les tickets dans l'ordre des messages du lot, mais un
                 * lot qui lève une exception n'en rend aucun. Un index calculé
                 * sur un tableau accumulé se décalerait alors pour tous les lots
                 * suivants, et attribuerait silencieusement les reçus aux
                 * mauvais clients. En lisant `chunk[i].to` dans la même boucle,
                 * le décalage est impossible par construction.
                 */
                ticketChunk.forEach((ticket, index) => {
                    const token = String(chunk[index]?.to ?? '');
                    if (ticket.status === 'error') {
                        this.logger.error(`Erreur d'envoi pour un token: ${ticket.message}`);
                        errors.push(ticket);
                        void this.revoquerSiAppareilInconnu(ticket, token);
                        return;
                    }
                    /**
                     * ⚠️ Seuls les tickets ACCEPTES entrent ici.
                     *
                     * L'ancien code empilait tout, erreurs comprises, puis
                     * recomptait les erreurs à part. `total_sent` contenait donc
                     * les échecs, qui figuraient aussi dans `total_failed` : sur
                     * cent jetons dont dix refusés, le backoffice affichait cent
                     * envoyés ET dix échoués.
                     */
                    tickets.push(ticket);
                    if (ticket.id) recus.push({ id: ticket.id, token });
                });

            } catch (error) {
                this.logger.error('Erreur critique lors de l\'envoi du chunk', error);
                errors.push(error);
            }
        }

        /**
         * ⚠️ On NE demande PLUS les reçus dans la foulée.
         *
         * Expo ne les prépare qu'en différé, jusqu'à une trentaine de minutes.
         * L'appel immédiat qui se trouvait ici ne pouvait structurellement rien
         * trouver : il consommait un aller-retour réseau pour rien, et faisait
         * croire à une vérification qui n'avait jamais lieu. Les identifiants
         * sont désormais RENDUS à l'appelant, à charge pour lui de les relire
         * plus tard.
         */
        return {
            status: 'processed',
            totalSent: messages.length,
            ticketsReceived: tickets.length,
            errorsCount: errors.length,
            recus,
        };
    }

    /**
     * Envoie des notifications personnalisées (un message différent par token)
     */
    async sendPersonalizedPushNotifications(
        messages: Array<{
            token: string;
            title: string;
            body: string;
            data?: Record<string, any>;
            subtitle?: string;
        }>,
    ) {
        const pushMessages: ExpoPushMessage[] = [];

        for (const msg of messages) {
            if (!Expo.isExpoPushToken(msg.token)) {
                this.logger.warn(`Token invalide ignoré: ${msg.token}`);
                continue;
            }
            pushMessages.push({
                to: msg.token,
                sound: 'default' as any,
                title: msg.title,
                body: msg.body,
                data: msg.data || {},
                subtitle: msg.subtitle,
                priority: 'high',
                channelId: 'default',
            });
        }

        if (pushMessages.length === 0) {
            return { status: 'skipped', totalSent: 0, ticketsReceived: 0, errorsCount: 0 };
        }

        const chunks = this.expo.chunkPushNotifications(pushMessages);
        const tickets: ExpoPushTicket[] = [];
        const errors: ExpoPushErrorReceipt[] = [];

        // Même traitement que l'envoi groupé : appariement dans le lot,
        // tickets acceptés seulement, reçus rendus à l'appelant.
        const recus: { id: string; token: string }[] = [];
        for (const chunk of chunks) {
            try {
                const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
                ticketChunk.forEach((ticket, index) => {
                    const token = String(chunk[index]?.to ?? '');
                    if (ticket.status === 'error') {
                        this.logger.error(`Erreur d'envoi: ${ticket.message}`);
                        errors.push(ticket);
                        void this.revoquerSiAppareilInconnu(ticket, token);
                        return;
                    }
                    tickets.push(ticket);
                    if (ticket.id) recus.push({ id: ticket.id, token });
                });
            } catch (error) {
                this.logger.error('Erreur critique chunk personnalisé', error);
                errors.push(error);
            }
        }

        return {
            status: 'processed',
            totalSent: pushMessages.length,
            ticketsReceived: tickets.length,
            errorsCount: errors.length,
            recus,
        };
    }

    /**
     * Phase 2 : relecture des reçus Expo.
     *
     * ⚠️ A appeler EN DIFFERE, jamais dans la foulée de l'envoi. Expo prépare
     * les reçus avec un retard pouvant aller jusqu'à une trentaine de minutes,
     * et ne les conserve qu'environ vingt-quatre heures. Trop tôt, on ne trouve
     * rien ; trop tard, l'information est perdue pour toujours.
     *
     * ⚠️ Un reçu ABSENT n'est pas un échec. Expo peut ne pas l'avoir encore
     * publié. Il est donc rangé dans `inconnus`, et surtout pas compté comme
     * une non remise : transformer un manque d'information en échec ferait
     * afficher des chiffres faux et alarmants.
     *
     * Vocabulaire : « remis » signifie remis à Apple ou à Google, pas affiché
     * sur l'écran du client. L'écart peut être important.
     */
    async verifierRecus(
        recus: { id: string; token: string }[],
    ): Promise<{ livres: string[]; echecs: string[]; inconnus: string[] }> {
        const parId = new Map(recus.map((r) => [r.id, r.token]));
        const livres: string[] = [];
        const echecs: string[] = [];
        const vus = new Set<string>();

        const lots = this.expo.chunkPushNotificationReceiptIds([...parId.keys()]);
        for (const lot of lots) {
            try {
                const reponses = await this.expo.getPushNotificationReceiptsAsync(lot);
                for (const receiptId in reponses) {
                    vus.add(receiptId);
                    const { status, message, details } = reponses[receiptId] as any;
                    if (status === 'ok') {
                        livres.push(receiptId);
                        continue;
                    }
                    echecs.push(receiptId);
                    this.logger.warn(`Remise refusée (${receiptId}) : ${message}`);
                    if (details?.error === 'DeviceNotRegistered') {
                        // ⚠️ On lit le jeton dans `details`, ou à défaut celui
                        // apparié à l'envoi. JAMAIS en analysant le texte du
                        // message d'erreur, qui n'a aucune stabilité.
                        await this.revoquerJeton(
                            details.expoPushToken ?? parId.get(receiptId) ?? '',
                            'DeviceNotRegistered (reçu)',
                        );
                    }
                }
            } catch (error) {
                // Un lot illisible laisse ses reçus en « inconnus », ce qui est
                // exactement le bon classement : on ne sait pas.
                this.logger.error(`Lecture des reçus impossible : ${error?.message ?? error}`);
            }
        }

        const inconnus = [...parId.keys()].filter((id) => !vus.has(id));
        return { livres, echecs, inconnus };
    }

    /**
     * Révoque un jeton quand Expo dit l'appareil inconnu, dès la phase 1.
     *
     * Le ticket de phase 1 porte déjà l'information pour les cas les plus
     * francs : inutile d'attendre le reçu pour cesser de viser un téléphone
     * qui n'existe plus.
     */
    private async revoquerSiAppareilInconnu(ticket: any, token: string) {
        if (ticket?.details?.error !== 'DeviceNotRegistered') return;
        await this.revoquerJeton(
            ticket.details.expoPushToken ?? token,
            'DeviceNotRegistered (ticket)',
        );
    }

    /**
     * Met un jeton Expo hors service, de façon REVERSIBLE.
     *
     * ⚠️ La valeur n'est pas détruite : elle est déplacée dans
     * `expo_push_token_revoked` avec sa date. Deux raisons. D'abord la
     * réversibilité, si une révocation s'avérait fautive. Ensuite parce que
     * l'application installée ne renvoie son jeton au serveur QUE s'il a
     * changé : effacer à tort rendrait un client injoignable jusqu'à ce qu'il
     * réinstalle.
     *
     * ⚠️ `expo_push_token` ne porte aucune contrainte d'unicité. On agit donc
     * par `updateMany` sur la valeur du jeton, jamais par `update` sur un
     * client supposé.
     *
     * ⚠️ Appelé UNIQUEMENT sur un `DeviceNotRegistered` explicite. Un échec
     * générique, un quota dépassé ou une panne réseau ne doivent rien révoquer.
     */
    private async revoquerJeton(token: string, cause: string) {
        if (!token) return;
        try {
            const { count } = await this.prisma.notificationSetting.updateMany({
                where: { expo_push_token: token },
                data: {
                    expo_push_token: null,
                    expo_push_token_revoked: token,
                    expo_push_token_revoked_at: new Date(),
                },
            });
            if (count > 0) {
                this.logger.log(`Jeton Expo révoqué (${cause}) sur ${count} réglage(s)`);
            }
        } catch (error) {
            this.logger.error(`Révocation impossible : ${error?.message ?? error}`);
        }
    }
}
