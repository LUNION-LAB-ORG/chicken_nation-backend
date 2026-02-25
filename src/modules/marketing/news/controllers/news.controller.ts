import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    Controller,
    Get,
    Param,
    Query,
    UseInterceptors
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NewsQueryDto } from '../dtos/news-query.dto';
import { NewsService } from '../services/news.service';

@ApiTags('Nouveautés - Client')
@ApiBearerAuth()
@Controller('marketing/news')
@UseInterceptors(CacheInterceptor)
export class NewsController {
    constructor(private readonly newsService: NewsService) { }

    /**
     * Liste des nouveautés actives (pour l'app mobile)
     */
    @Get()
    @ApiOperation({ summary: 'Récupérer toutes les nouveautés actives' })
    async findAllActive(@Query() query: NewsQueryDto) {
        return this.newsService.findAllActive(query);
    }

    /**
     * Détails d'une nouveauté
     */
    @Get(':id')
    @ApiOperation({ summary: 'Récupérer les détails d\'une nouveauté' })
    async findOne(@Param('id') id: string) {
        return this.newsService.findOne(id);
    }
}