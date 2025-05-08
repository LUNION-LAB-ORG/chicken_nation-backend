import { Injectable } from '@nestjs/common';
import { Twilio } from 'twilio';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TwilioService {
    private readonly twilioClient: Twilio;
    private readonly accountSid: string;
    private readonly authToken: string;
    private readonly twilioPhoneNumber: string;

    constructor(private readonly configService: ConfigService) {
        this.accountSid = this.configService.get<string>('ACCOUNT_SID') ?? "";
        this.authToken = this.configService.get<string>('AUTH_TOKEN') ?? "";
        this.twilioPhoneNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') ?? "";
        this.twilioClient = new Twilio(this.accountSid, this.authToken);
    }

    async sendOtp(phoneNumber: string, otp: string) {
        try {
            await this.twilioClient.messages.create({
                body: `Votre code de confirmation est ${otp}`,
                from: this.twilioPhoneNumber,
                to: phoneNumber,
            });
        } catch (error) {
            console.error('Error sending OTP:', error);
            throw error;
        }
    }
}
