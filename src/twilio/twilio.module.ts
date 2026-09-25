import { Module, Global } from '@nestjs/common';
import { TwilioService } from './services/twilio.service';

/**
 * ⚠️ Aucun contrôleur, volontairement (audit des droits du 25/09).
 * Les routes POST /Twilio/send-otp, /send-whatsapp et /send-sms envoyaient un
 * texte ou un modèle libre vers n'importe quel numéro, depuis l'expéditeur SMS
 * et le numéro WhatsApp officiels, pour tout compte du personnel. Personne ne
 * les appelait : les envois légitimes (OTP clients et livreurs, notifications)
 * passent par TwilioService injecté. Ne pas les rétablir sans une garde
 * UserPermissionsGuard posée méthode par méthode.
 */
@Global()
@Module({
  providers: [TwilioService],
  exports: [TwilioService]
})
export class TwilioModule { }
