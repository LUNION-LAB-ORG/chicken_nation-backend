import { Module, Global } from '@nestjs/common';
import { TwilioService } from './services/twilio.service';

@Global()
@Module({
  providers: [TwilioService],
  exports: [TwilioService]
})
export class TwilioModule { }
