import { Module } from '@nestjs/common';
import { CardRequestController } from './controllers/card-request.controller';
import { CardAdminController } from './controllers/card-admin.controller';
import { CardRequestService } from './services/card-request.service';
import { CardGenerationService } from './services/card-generation.service';
import { S3Module } from 'src/s3/s3.module';


@Module({
    imports: [S3Module],
    controllers: [CardRequestController, CardAdminController],
    providers: [CardRequestService, CardGenerationService],
    exports: [CardRequestService, CardGenerationService],
})
export class CardNationModule { }