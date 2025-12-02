import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TwilioService } from './services/twilio.service';

@ApiTags('Twilio')
@Controller('Twilio')
export class TwilioController {
  constructor(private readonly twilioService: TwilioService,
  ) { }

  @Post('send-otp')
  async sendOtp(@Body() body: { phoneNumber: string, otp: string }) {
    return this.twilioService.sendOtp(body);
  }

  @Post('send-whatsapp')
  async sendWhatsapp(@Body() body: { phoneNumber: string, contentSid: string, contentVariables: any }) {
    console.log(body.contentVariables, typeof body.contentVariables)
    return this.twilioService.sendWhatsappMessage({ ...body, contentVariables: JSON.stringify(body.contentVariables) });
  }

  @Post('send-sms')
  async sendSms(@Body() body: { phoneNumber: string, message: string }) {
    return this.twilioService.sendSmsMessage(body);
  }

}
