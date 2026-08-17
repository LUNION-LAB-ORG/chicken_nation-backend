import { OrderDepartureNotifierService } from './services/order-departure-notifier.service';
import { Module, Global } from '@nestjs/common';
import { GenerateDataService } from './services/generate-data.service';
import { GenerateConfigService } from './services/generate-config.service';
@Global()
@Module({
  providers: [GenerateDataService, GenerateConfigService, OrderDepartureNotifierService],
  exports: [GenerateDataService, GenerateConfigService, OrderDepartureNotifierService],
})
export class CommonModule { }
