import { Module, Global } from '@nestjs/common';
import { GenerateDataService } from './services/generate-data.service';
import { GenerateConfigService } from './services/generate-config.service';
@Global()
@Module({
  providers: [GenerateDataService, GenerateConfigService],
  exports: [GenerateDataService, GenerateConfigService],
})
export class CommonModule { }
