import { Module } from '@nestjs/common';
import { TurboController } from './controllers/turbo.controller';
import { TurboService } from './services/turbo.service';

@Module({
  controllers: [TurboController],
  providers: [TurboService],
})
export class TurboModule { }
