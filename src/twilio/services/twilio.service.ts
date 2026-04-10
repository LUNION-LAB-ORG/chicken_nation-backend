import { Injectable } from '@nestjs/common';
import { Twilio } from 'twilio';
import { ConfigService } from '@nestjs/config';
import { MessageInstance } from 'twilio/lib/rest/api/v2010/account/message';
import { SettingsService } from 'src/modules/settings/settings.service';

@Injectable()
export class TwilioService {
    private twilioClient: Twilio | null = null;
    private cachedConfig: {
        accountSid: string;
        authToken: string;
        phoneNumber: string;
        whatsappNumber: string;
    } | null = null;

    private readonly twilioWhatsappTemplate = {
        otp_template: {
            name: "otp_template",
            sid: "HX81d8446f928903afae7e7fa28b3ca324",
            language: "fr",
            variables: [
                {
                    name: "1",
                    type: "string",
                    description: "OTP"
                }
            ]
        },
        tracking_order: {
            name: "tracking_order",
            sid: "HX3601e215533e74979a7848ff0ff723ce",
            language: "fr",
            bodyVariables: [
                { name: "1", description: "Prenom du client" },
                { name: "2", description: "Reference de la commande" },
            ],
            buttonVariables: [
                { name: "1", description: "Reference de la commande (suffixe URL)" },
            ],
        },
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly settingsService: SettingsService,
    ) {}

    /**
     * Récupère la config Twilio depuis Settings DB avec fallback .env
     * et crée/met à jour le client si nécessaire
     */
    private async getConfig() {
        const config = await this.settingsService.getManyOrEnv({
            twilio_account_sid: 'ACCOUNT_SID',
            twilio_auth_token: 'AUTH_TOKEN',
            twilio_phone_number: 'TWILIO_PHONE_NUMBER',
            twilio_whatsapp_number: 'TWILIO_WHATSAPP_NUMBER',
        });

        const accountSid = config.twilio_account_sid ?? '';
        const authToken = config.twilio_auth_token ?? '';
        const phoneNumber = config.twilio_phone_number ?? '';
        const whatsappNumber = config.twilio_whatsapp_number ?? '';

        // Recréer le client si la config a changé
        if (
            !this.twilioClient ||
            !this.cachedConfig ||
            this.cachedConfig.accountSid !== accountSid ||
            this.cachedConfig.authToken !== authToken
        ) {
            this.twilioClient = new Twilio(accountSid, authToken);
            this.cachedConfig = { accountSid, authToken, phoneNumber, whatsappNumber };
        }

        return { client: this.twilioClient, phoneNumber, whatsappNumber };
    }

    /**
     * Vérifie si WhatsApp est activé via le setting `twilio_whatsapp_enabled`.
     * Par défaut true si le setting n'existe pas.
     */
    private async isWhatsAppEnabled(): Promise<boolean> {
        const value = await this.settingsService.getOrEnv(
            'twilio_whatsapp_enabled',
            'TWILIO_WHATSAPP_ENABLED',
            'true',
        );
        return value === 'true' || value === '1';
    }

    /**
     * Vérifie si l'envoi post-commande est activé via le setting `twilio_post_order_enabled`.
     * Par défaut true si le setting n'existe pas.
     */
    private async isPostOrderEnabled(): Promise<boolean> {
        const value = await this.settingsService.getOrEnv(
            'twilio_post_order_enabled',
            'TWILIO_POST_ORDER_ENABLED',
            'true',
        );
        return value === 'true' || value === '1';
    }

    async sendOtp({ phoneNumber, otp }: { phoneNumber: string, otp: string }) {
        const env = this.configService.get<string>('NODE_ENV');
        if (env !== 'production') {
            console.log(`OTP for ${phoneNumber}: ${otp}`);
            return true;
        }

        const smsMessage = `Votre code de vérification Chicken Nation est : ${otp}\n\nCe code expire dans 5 minutes.`;

        // Si WhatsApp est activé, tenter WhatsApp d'abord
        if (await this.isWhatsAppEnabled()) {
            const whatsappResult = await this.sendWhatsappMessage({
                phoneNumber,
                contentSid: this.twilioWhatsappTemplate.otp_template.sid,
                contentVariables: JSON.stringify({
                    [this.twilioWhatsappTemplate.otp_template.variables[0].name]: otp
                })
            });

            if (whatsappResult) return whatsappResult;
            console.log(`[OTP] WhatsApp échoué pour ${phoneNumber}, bascule sur SMS`);
        } else {
            console.log(`[OTP] WhatsApp désactivé, envoi par SMS pour ${phoneNumber}`);
        }

        return await this.sendSmsMessage({ phoneNumber, message: smsMessage });
    }

    /**
     * Envoie un message de suivi de commande.
     * Si WhatsApp est activé, tente WhatsApp d'abord puis fallback SMS.
     * Si WhatsApp est désactivé, envoie directement par SMS.
     * Utilisé uniquement pour les clients qui n'ont PAS l'app (pas de push token).
     */
    async sendTrackingOrder({ phoneNumber, customerName, orderReference }: {
        phoneNumber: string;
        customerName: string;
        orderReference: string;
    }) {
        const env = this.configService.get<string>('NODE_ENV');
        if (env !== 'production') {
            console.log(`[TrackingOrder] Message pour ${customerName} (${phoneNumber}) - Commande ${orderReference}`);
            return true;
        }

        // Vérifier si l'envoi post-commande est activé
        if (!(await this.isPostOrderEnabled())) {
            console.log(`[TrackingOrder] Envoi post-commande désactivé, message ignoré pour ${phoneNumber}`);
            return null;
        }

        const name = customerName || "Client";
        const smsMessage = `Bonjour ${name} ! Votre commande ${orderReference} a bien été reçue. Merci pour votre confiance. - Chicken Nation`;

        // Si WhatsApp est activé, tenter WhatsApp d'abord
        if (await this.isWhatsAppEnabled()) {
            const template = this.twilioWhatsappTemplate.tracking_order;
            try {
                const whatsappResult = await this.sendWhatsappMessage({
                    phoneNumber,
                    contentSid: template.sid,
                    contentVariables: JSON.stringify({
                        "1": name,
                        "2": orderReference || "N/A",
                        "3": orderReference || "N/A",
                    }),
                });

                if (whatsappResult) return whatsappResult;
            } catch (error: any) {
                console.warn(`[TrackingOrder] WhatsApp échoué: ${error?.message || error}`);
            }
            console.log(`[TrackingOrder] Bascule sur SMS pour ${name} (${phoneNumber})`);
        } else {
            console.log(`[TrackingOrder] WhatsApp désactivé, envoi par SMS pour ${name} (${phoneNumber})`);
        }

        // SMS
        try {
            return await this.sendSmsMessage({ phoneNumber, message: smsMessage });
        } catch (error: any) {
            console.error(`[TrackingOrder] Erreur envoi SMS: ${error?.message || error}`);
            return null;
        }
    }

    async sendSmsMessage({ phoneNumber, message }: { phoneNumber: string, message: string }): Promise<MessageInstance | null> {
        try {
            const { client, phoneNumber: fromNumber } = await this.getConfig();
            const response = await client.messages.create({
                body: message,
                from: fromNumber,
                to: this.formatNumber(phoneNumber),
            });

            return response;
        } catch (error: any) {
            console.error('[SMS] Error sending message:', error?.message || error);
            return null;
        }
    }

    async sendWhatsappMessage({ phoneNumber, contentSid, contentVariables }: { phoneNumber: string, contentSid: string, contentVariables: string }): Promise<MessageInstance | null> {
        try {
            const { client, whatsappNumber } = await this.getConfig();
            const to = `whatsapp:${this.formatNumber(phoneNumber)}`;
            const from = `whatsapp:${whatsappNumber}`;
            console.log(`[WhatsApp] Sending: from=${from}, to=${to}, contentSid=${contentSid}, vars=${contentVariables}`);
            const response = await client.messages.create({
                contentSid,
                contentVariables,
                from,
                to,
            });
            console.log(`[WhatsApp] Sent successfully: sid=${response.sid}, status=${response.status}`);
            return response;

        } catch (error: any) {
            console.error('[WhatsApp] Error sending message:', error?.message || error);
            return null;
        }
    }

    formatNumber(phoneNumber: string) {
        let phone = phoneNumber.replace(/\D/g, '');
        if (!phone) return '';
        if (!phone.startsWith('+')) phone = `+${phone}`;
        return phone;
    }
}
