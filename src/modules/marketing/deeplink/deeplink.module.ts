import { Module } from '@nestjs/common';
import { DeeplinkController } from './deeplink.controller';
import { DeeplinkHelper } from './deeplink.helper';
import { DeeplinkService } from './deeplink.service';

@Module({
  controllers: [DeeplinkController],
  providers: [DeeplinkService, DeeplinkHelper],
})
export class DeeplinkModule { }
