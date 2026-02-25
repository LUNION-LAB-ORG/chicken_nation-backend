import { Module } from '@nestjs/common';
import { AppMobileController } from './app-mobile.controller';
import { AppMobileService } from './app-mobile.service';

@Module({
  controllers: [AppMobileController],
  providers: [AppMobileService],
})
export class AppMobileModule { }
