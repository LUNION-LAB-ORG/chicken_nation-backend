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

    async sendOtp({ phoneNumber, otp }: { phoneNumber: string, otp: string }) {
        const env = this.configService.get<string>('NODE_ENV');
        if (env !== 'production') {
            console.log(`OTP for ${phoneNumber}: ${otp}`);
            return true;
        }

        // SMS fallback (WhatsApp bloqué - erreur 63051)
        return await this.sendSmsMessage({
            phoneNumber,
            message: `Votre code de vérification Chicken Nation est : ${otp}\n\nCe code expire dans 5 minutes.`,
        });

        // TODO: Rétablir WhatsApp après déblocage du compte
        // return await this.sendWhatsappMessage({
        //     phoneNumber,
        //     contentSid: this.twilioWhatsappTemplate.otp_template.sid,
        //     contentVariables: JSON.stringify({
        //         [this.twilioWhatsappTemplate.otp_template.variables[0].name]: otp
        //     })
        // });
    }

    /**
     * Envoie un WhatsApp de suivi de commande avec deeplink vers l'app.
     * Utilisé uniquement pour les clients qui n'ont PAS l'app (pas de push token).
     */
    async sendTrackingOrder({ phoneNumber, customerName, orderReference }: {
        phoneNumber: string;
        customerName: string;
        orderReference: string;
    }) {
        const env = this.configService.get<string>('NODE_ENV');
        if (env !== 'production') {
            console.log(`[TrackingOrder] SMS pour ${customerName} (${phoneNumber}) - Commande ${orderReference}`);
            return true;
        }

        // SMS fallback (WhatsApp bloqué - erreur 63051)
        try {
            const name = customerName || "Client";
            const result = await this.sendSmsMessage({
                phoneNumber,
                message: `Bonjour ${name} ! Votre commande ${orderReference} a bien été reçue. Merci pour votre confiance. - Chicken Nation`,
            });
            return result;
        } catch (error: any) {
            console.error(`[TrackingOrder] Erreur envoi SMS: ${error?.message || error}`);
            return null;
        }

        // TODO: Rétablir WhatsApp après déblocage du compte
        // const template = this.twilioWhatsappTemplate.tracking_order;
        // try {
        //     const result = await this.sendWhatsappMessage({
        //         phoneNumber,
        //         contentSid: template.sid,
        //         contentVariables: JSON.stringify({
        //             "1": customerName || "Client",
        //             "2": orderReference || "N/A",
        //             "3": orderReference || "N/A",
        //         }),
        //     });
        //     return result;
        // } catch (error: any) {
        //     console.error(`[TrackingOrder] Erreur envoi: ${error?.message || error}`);
        //     return null;
        // }
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
            console.error('Error sending message:', error);
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
