import { Injectable } from '@nestjs/common';
import { Twilio } from 'twilio';
import { ACCOUNT_SID, AUTH_TOKEN, TWILIO_PHONE_NUMBER } from './twilio.constante';

@Injectable()
export class TwilioService {
    private readonly twilioClient: Twilio;

    constructor() {
        this.twilioClient = new Twilio(ACCOUNT_SID, AUTH_TOKEN);
    }

    async sendOtp(phoneNumber: string, otp: string) {
        try {
            await this.twilioClient.messages.create({
                body: `Votre code de confirmation est ${otp}`,
                from: TWILIO_PHONE_NUMBER,
                to: phoneNumber,
            });
        } catch (error) {
            console.error('Error sending OTP:', error);
            throw error;
        }
    }
}
