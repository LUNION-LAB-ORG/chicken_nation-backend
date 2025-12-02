import { Module, Global } from '@nestjs/common';
import { TwilioService } from './services/twilio.service';
import { TwilioController } from './twilio.controller';

@Global()
@Module({
  controllers: [TwilioController],
  providers: [TwilioService],
  exports: [TwilioService]
})
export class TwilioModule { }
