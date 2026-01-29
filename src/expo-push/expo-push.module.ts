import { Global, Module } from '@nestjs/common';
import { ExpoPushService } from './expo-push.service';
import { ExpoPushController } from './expo-push.controller';

@Global()
@Module({
    controllers: [ExpoPushController],
    providers: [ExpoPushService],
    exports: [ExpoPushService],
})
export class ExpoPushModule { }