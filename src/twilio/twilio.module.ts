import { Global, Module } from '@nestjs/common';
import { TwilioService } from './twilio.service';
import { TwilioController } from './twilio.controller';

@Global()
@Module({
  providers: [TwilioService],
  controllers: [TwilioController],
  exports: [TwilioService]
})
export class TwilioModule { }
