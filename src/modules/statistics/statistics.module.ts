import { Module } from '@nestjs/common';
import { StatisticsController } from './controllers/statistics.controller';
import { StatisticsService } from './services/statistics.service';
import { icons } from './constantes/statistics.constante';

@Module({
    controllers: [StatisticsController],
    providers: [{
        provide: "ICON",
        useValue: icons
    }, StatisticsService],
    exports: [StatisticsService],
})
export class StatisticsModule { }