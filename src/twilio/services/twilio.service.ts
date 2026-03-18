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
        }
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

        return await this.sendWhatsappMessage({
            phoneNumber,
            contentSid: this.twilioWhatsappTemplate.otp_template.sid,
            contentVariables: JSON.stringify({
                [this.twilioWhatsappTemplate.otp_template.variables[0].name]: otp
            })
        });
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
            const response = await client.messages.create({
                contentSid,
                contentVariables,
                from: `whatsapp:${whatsappNumber}`,
                to: `whatsapp:${this.formatNumber(phoneNumber)}`,
            });
            return response;

        } catch (error: any) {
            console.error('Error sending message:', error);
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
