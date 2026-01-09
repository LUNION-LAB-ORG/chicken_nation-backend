import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { S3Service } from 'src/s3/s3.service';
import { CreateNewsDto } from '../dtos/create-news.dto';
import { UpdateNewsDto } from '../dtos/update-news.dto';
import { NewsQueryDto } from '../dtos/news-query.dto';

@Injectable()
export class NewsService {
    private readonly logger = new Logger(NewsService.name);

    constructor(
        private prisma: PrismaService,
        private readonly s3service: S3Service,
    ) { }

    /**
     * Créer une nouvelle news (backoffice)
     */
    async create(createDto: CreateNewsDto, file?: Express.Multer.File) {
        let imageUrl: string | undefined;

        // Upload de l'image si fournie
        if (file) {
            const result = await this.s3service.uploadFile({
                buffer: file.buffer,
                path: 'chicken-nation/news',
                originalname: file.originalname,
                mimetype: file.mimetype,
            });
            imageUrl = result?.key;
        }

        const news = await this.prisma.news.create({
            data: {
                title: createDto.title,
                content: createDto.content,
                imageUrl,
                link: createDto.link,
                isActive: createDto.isActive ?? true,
            },
        });

        this.logger.log(`Nouveauté créée : ${news.id} - ${news.title}`);

        return {
            success: true,
            message: 'Nouveauté créée avec succès',
            data: news,
        };
    }

    /**
     * Liste de toutes les news (backoffice)
     */
    async findAll(query: NewsQueryDto) {
        const { page = 1, limit = 10, search, isActive } = query;
        const skip = (page - 1) * limit;

        const where: Prisma.NewsWhereInput = {};

        if (typeof isActive === 'boolean') {
            where.isActive = isActive;
        }

        if (search) {
            where.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { content: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [news, total] = await Promise.all([
            this.prisma.news.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.news.count({ where }),
        ]);

        return {
            data: news,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Liste des news actives (app mobile)
     */
    async findAllActive(query: NewsQueryDto) {
        const { page = 1, limit = 10 } = query;
        const skip = (page - 1) * limit;

        const where: Prisma.NewsWhereInput = {
            isActive: true,
        };

        const [news, total] = await Promise.all([
            this.prisma.news.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.news.count({ where }),
        ]);

        return {
            data: news,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Récupérer une news par ID
     */
    async findOne(id: string) {
        const news = await this.prisma.news.findUnique({
            where: { id },
        });

        if (!news) {
            throw new NotFoundException('Nouveauté non trouvée');
        }

        return news;
    }

    /**
     * Mettre à jour une news
     */
    async update(id: string, updateDto: UpdateNewsDto, file?: Express.Multer.File) {
        const existingNews = await this.findOne(id);

        let imageUrl = existingNews.imageUrl;

        // Upload de la nouvelle image si fournie
        if (file) {
            const result = await this.s3service.uploadFile({
                buffer: file.buffer,
                path: 'chicken-nation/news',
                originalname: file.originalname,
                mimetype: file.mimetype,
            });
            imageUrl = result?.key || null;

            // Supprimer l'ancienne image
            if (existingNews.imageUrl) {
                await this.s3service.deleteFile(existingNews.imageUrl);
            }
        }

        const updatedNews = await this.prisma.news.update({
            where: { id },
            data: {
                title: updateDto.title,
                content: updateDto.content,
                imageUrl,
                link: updateDto.link,
                isActive: updateDto.isActive,
            },
        });

        this.logger.log(`Nouveauté mise à jour : ${id} - ${updatedNews.title}`);

        return {
            success: true,
            message: 'Nouveauté mise à jour avec succès',
            data: updatedNews,
        };
    }

    /**
     * Supprimer une news
     */
    async remove(id: string) {
        const news = await this.findOne(id);

        await this.prisma.news.delete({
            where: { id },
        });

        // Supprimer l'image associée
        if (news.imageUrl) {
            await this.s3service.deleteFile(news.imageUrl);
        }

        this.logger.log(`Nouveauté supprimée : ${id} - ${news.title}`);

        return {
            success: true,
            message: 'Nouveauté supprimée avec succès',
        };
    }

    /**
     * Activer/Désactiver une news
     */
    async toggleActive(id: string) {
        const news = await this.findOne(id);

        const updatedNews = await this.prisma.news.update({
            where: { id },
            data: {
                isActive: !news.isActive,
            },
        });

        this.logger.log(
            `Nouveauté ${updatedNews.isActive ? 'activée' : 'désactivée'} : ${id}`,
        );

        return {
            success: true,
            message: `Nouveauté ${updatedNews.isActive ? 'activée' : 'désactivée'} avec succès`,
            data: updatedNews,
        };
    }

    /**
     * Statistiques des news
     */
    async getStats() {
        const [total, active, inactive] = await Promise.all([
            this.prisma.news.count(),
            this.prisma.news.count({ where: { isActive: true } }),
            this.prisma.news.count({ where: { isActive: false } }),
        ]);

        return {
            total,
            active,
            inactive,
        };
    }
}