import { Injectable } from '@nestjs/common';
import { Twilio } from 'twilio';
import { ConfigService } from '@nestjs/config';
import { MessageInstance } from 'twilio/lib/rest/api/v2010/account/message';

@Injectable()
export class TwilioService {
    private readonly twilioClient: Twilio;
    private readonly accountSid: string;
    private readonly authToken: string;
    private readonly twilioPhoneNumber: string;
    private readonly twilioWhatsappNumber: string;
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

    constructor(private readonly configService: ConfigService) {
        this.accountSid = this.configService.get<string>('ACCOUNT_SID') ?? "";
        this.authToken = this.configService.get<string>('AUTH_TOKEN') ?? "";
        this.twilioPhoneNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') ?? "";
        this.twilioWhatsappNumber = this.configService.get<string>('TWILIO_WHATSAPP_NUMBER') ?? "";

        this.twilioClient = new Twilio(this.accountSid, this.authToken);
    }

    async sendOtp({ phoneNumber, otp }: { phoneNumber: string, otp: string }) {

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
            const response = await this.twilioClient.messages.create({
                body: message,
                from: this.twilioPhoneNumber,
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
            const response = await this.twilioClient.messages.create({
                contentSid,
                contentVariables,
                from: `whatsapp:${this.twilioWhatsappNumber}`,
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
