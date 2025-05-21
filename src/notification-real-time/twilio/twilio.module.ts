import { Global, Module } from '@nestjs/common';
import { TwilioService } from './services/twilio.service';
import { TwilioController } from './controllers/twilio.controller';

@Global()
@Module({
  providers: [TwilioService],
  controllers: [TwilioController],
  exports: [TwilioService]
})
export class TwilioModule { }
