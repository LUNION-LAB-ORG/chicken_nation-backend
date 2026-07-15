import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { TwilioService } from './services/twilio.service';

/**
 * ⚠️ SÉCURITÉ : ces endpoints déclenchent des envois SMS/WhatsApp facturés sur
 * le compte Twilio de l'entreprise. Ils étaient AUPARAVANT PUBLICS (aucune
 * garde) → n'importe qui pouvait spammer des messages à n'importe quel numéro.
 * Ils sont désormais réservés au STAFF authentifié (JwtAuthGuard). Le flux OTP
 * client légitime n'appelle PAS ces routes : il passe par AuthService qui
 * utilise TwilioService en interne (injection), pas via HTTP.
 */
@ApiTags('Twilio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('Twilio')
export class TwilioController {
  constructor(private readonly twilioService: TwilioService) {}

  @Post('send-otp')
  async sendOtp(@Body() body: { phoneNumber: string; otp: string }) {
    return this.twilioService.sendOtp(body);
  }

  @Post('send-whatsapp')
  async sendWhatsapp(
    @Body()
    body: {
      phoneNumber: string;
      contentSid: string;
      contentVariables: any;
    },
  ) {
    return this.twilioService.sendWhatsappMessage({
      ...body,
      contentVariables: JSON.stringify(body.contentVariables),
    });
  }

  @Post('send-sms')
  async sendSms(@Body() body: { phoneNumber: string; message: string }) {
    return this.twilioService.sendSmsMessage(body);
  }
}
