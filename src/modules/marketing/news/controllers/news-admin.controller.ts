import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    Query,
    UseGuards,
    UseInterceptors,
    UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { NewsService } from '../services/news.service';
import { CreateNewsDto } from '../dtos/create-news.dto';
import { UpdateNewsDto } from '../dtos/update-news.dto';
import { NewsQueryDto } from '../dtos/news-query.dto';

@ApiTags('Nouveautés - Administration')
@ApiBearerAuth()
@Controller('admin/news')
@UseGuards(JwtAuthGuard)
export class NewsAdminController {
    constructor(private readonly newsService: NewsService) { }

    /**
     * Créer une nouvelle news
     */
    @Post()
    @UseInterceptors(FileInterceptor('image'))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Créer une nouvelle nouveauté' })
    async create(
        @Body() createDto: CreateNewsDto,
        @UploadedFile() file: Express.Multer.File,
    ) {
        return this.newsService.create(createDto, file);
    }

    /**
     * Liste de toutes les news
     */
    @Get()
    @ApiOperation({ summary: 'Récupérer toutes les nouveautés (actives et inactives)' })
    async findAll(@Query() query: NewsQueryDto) {
        return this.newsService.findAll(query);
    }

    /**
     * Statistiques des news
     */
    @Get('stats')
    @ApiOperation({ summary: 'Récupérer les statistiques des nouveautés' })
    async getStats() {
        return this.newsService.getStats();
    }

    /**
     * Détails d'une news
     */
    @Get(':id')
    @ApiOperation({ summary: 'Récupérer les détails d\'une nouveauté' })
    async findOne(@Param('id') id: string) {
        return this.newsService.findOne(id);
    }

    /**
     * Mettre à jour une news
     */
    @Patch(':id')
    @UseInterceptors(FileInterceptor('image'))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Mettre à jour une nouveauté' })
    async update(
        @Param('id') id: string,
        @Body() updateDto: UpdateNewsDto,
        @UploadedFile() file: Express.Multer.File,
    ) {
        return this.newsService.update(id, updateDto, file);
    }

    /**
     * Activer/Désactiver une news
     */
    @Patch(':id/toggle-active')
    @ApiOperation({ summary: 'Activer ou désactiver une nouveauté' })
    async toggleActive(@Param('id') id: string) {
        return this.newsService.toggleActive(id);
    }

    /**
     * Supprimer une news
     */
    @Delete(':id')
    @ApiOperation({ summary: 'Supprimer une nouveauté' })
    async remove(@Param('id') id: string) {
        return this.newsService.remove(id);
    }
}