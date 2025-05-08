import { Controller, Post, Body } from '@nestjs/common';
import { TwilioService } from './twilio.service';

@Controller('twilio')
export class TwilioController {
    constructor(private readonly twilioService: TwilioService) { }

    @Post('send-otp')
    async sendOtp(@Body() body: { phoneNumber: string }) {
        const { phoneNumber } = body;
        const otp = '0118';
        await this.twilioService.sendOtp(phoneNumber, otp);
        return { message: 'OTP sent successfully' };
    }
}
