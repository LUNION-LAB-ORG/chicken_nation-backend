import { Module } from '@nestjs/common';
import { AppMobileController } from './app-mobile.controller';
import { AppMobileHelper } from './app-mobile.helper';
import { AppMobileService } from './app-mobile.service';

@Module({
  controllers: [AppMobileController],
  providers: [AppMobileService, AppMobileHelper],
})
export class AppMobileModule { }
