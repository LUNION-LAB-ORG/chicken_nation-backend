import { Module } from '@nestjs/common';
import { RecordClickController } from './recordClick.controller';
import { RecordClickHelper } from './recordClick.helper';
import { RecordClickService } from './recordClick.service';

@Module({
  controllers: [RecordClickController],
  providers: [RecordClickService, RecordClickHelper],
})
export class RecordClickModule { }
