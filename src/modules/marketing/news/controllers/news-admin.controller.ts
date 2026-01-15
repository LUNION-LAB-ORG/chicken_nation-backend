import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateNewsDto } from '../dtos/create-news.dto';
import { NewsQueryDto } from '../dtos/news-query.dto';
import { UpdateNewsDto } from '../dtos/update-news.dto';
import { NewsService } from '../services/news.service';

@ApiTags('Nouveautés - Administration')
@ApiBearerAuth()
@Controller('admin/news')
export class NewsAdminController {
    constructor(private readonly newsService: NewsService) { }

    /**
     * Créer une nouvelle news
     */
    @Post()
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.CREATE)
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
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.READ)
    @ApiOperation({ summary: 'Récupérer toutes les nouveautés (actives et inactives)' })
    async findAll(@Query() query: NewsQueryDto) {
        return this.newsService.findAll(query);
    }

    /**
     * Statistiques des news
     */
    @Get('stats')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.REPORT)
    @ApiOperation({ summary: 'Récupérer les statistiques des nouveautés' })
    async getStats() {
        return this.newsService.getStats();
    }

    /**
     * Détails d'une news
     */
    @Get(':id')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.READ)
    @ApiOperation({ summary: 'Récupérer les détails d\'une nouveauté' })
    async findOne(@Param('id') id: string) {
        return this.newsService.findOne(id);
    }

    /**
     * Mettre à jour une news
     */
    @Patch(':id')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.UPDATE)
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
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.UPDATE)
    @ApiOperation({ summary: 'Activer ou désactiver une nouveauté' })
    async toggleActive(@Param('id') id: string) {
        return this.newsService.toggleActive(id);
    }

    /**
     * Supprimer une news
     */
    @Delete(':id')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MARKETING, Action.DELETE)
    @ApiOperation({ summary: 'Supprimer une nouveauté' })
    async remove(@Param('id') id: string) {
        return this.newsService.remove(id);
    }
}