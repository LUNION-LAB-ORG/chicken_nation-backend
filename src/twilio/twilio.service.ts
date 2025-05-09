import { Injectable } from '@nestjs/common';
import { Twilio } from 'twilio';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TwilioService {
    private readonly twilioClient: Twilio;
    private readonly accountSid: string;
    private readonly authToken: string;
    private readonly twilioPhoneNumber: string;
    private readonly twilioWhatsappNumber: string;

    constructor(private readonly configService: ConfigService) {
        this.accountSid = this.configService.get<string>('ACCOUNT_SID') ?? "";
        this.authToken = this.configService.get<string>('AUTH_TOKEN') ?? "";
        this.twilioPhoneNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') ?? "";
        this.twilioWhatsappNumber = this.configService.get<string>('TWILIO_WHATSAPP_NUMBER') ?? "";

        this.twilioClient = new Twilio(this.accountSid, this.authToken);
    }

    async sendOtp(phoneNumber: string, otp: string) {

        return await this.sendMessage(phoneNumber, `Votre code de confirmation est : ${otp}`, "sms");
    }

    async sendMessage(phoneNumber: string, message: string, type: "sms" | "whatsapp") {
        try {
            await this.twilioClient.messages.create({
                body: message,
                from: type === "sms" ? this.twilioPhoneNumber : `whatsapp:${this.twilioWhatsappNumber}`,
                to: type === "sms" ? this.formatNumber(phoneNumber) : `whatsapp:${this.formatNumber(phoneNumber)}`,
            });
            return true;
        } catch (error: any) {
            console.error('Error sending message:', error);
            return false;
        }
    }

    formatNumber(phoneNumber: string) {
        let phone = phoneNumber.replace(/\D/g, '');
        if (!phone) return '';
        if (!phone.startsWith('+')) phone = `+${phone}`;
        return phone;
    }
}
