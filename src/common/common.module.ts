import { Module, Global } from '@nestjs/common';
import { GenerateDataService } from './services/generate-data.service';

@Global()
@Module({
  providers: [GenerateDataService],
  exports: [GenerateDataService],
})
export class CommonModule { }
