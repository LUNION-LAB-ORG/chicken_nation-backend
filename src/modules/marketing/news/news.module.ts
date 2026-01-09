import { Module } from '@nestjs/common';
import { NewsAdminController } from './controllers/news-admin.controller';
import { NewsController } from './controllers/news.controller';
import { NewsService } from './services/news.service';
import { S3Module } from 'src/s3/s3.module';

@Module({
    imports: [S3Module],
    controllers: [NewsController, NewsAdminController],
    providers: [NewsService],
    exports: [NewsService],
})
export class NewsModule { }