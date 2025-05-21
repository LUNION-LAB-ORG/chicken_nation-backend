import { Controller, Post, Body } from '@nestjs/common';
import { TwilioService } from '../services/twilio.service';

@Controller('twilio')
export class TwilioController {
    constructor(private readonly twilioService: TwilioService) { }

    @Post('send-message')
    async sendTest(@Body() body: { phoneNumber: string, message: string }) {
        const { phoneNumber, message } = body;
        await this.twilioService.sendMessage(phoneNumber, message, "sms");
        return { message: 'Message sent successfully' };
    }
}
