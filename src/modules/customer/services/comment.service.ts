import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateCommentDto, UpdateCommentDto, CommentResponseDto, DishCommentsResponseDto, GetCommentsQueryDto } from '../dto/comment.dto';
import { EntityStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';

@Injectable()
export class CommentService {
    constructor(private prisma: PrismaService) { }

    // Créer un commentaire
    async createComment(customerId: string, createCommentDto: CreateCommentDto): Promise<CommentResponseDto> {
        const { message, rating, order_id } = createCommentDto;

        // Vérifier que la commande existe et appartient au client
        const order = await this.prisma.order.findFirst({
            where: {
                id: order_id,
                customer_id: customerId,
            },
        });

        if (!order) {
            throw new NotFoundException('Commande non trouvée ou non autorisée');
        }

        // Vérifier que la commande est terminée
        if (order.status !== OrderStatus.COMPLETED) {
            throw new BadRequestException('Vous ne pouvez commenter que les commandes terminées');
        }

        // Vérifier qu'il n'y a pas déjà un commentaire pour cette commande
        const existingComment = await this.prisma.comment.findFirst({
            where: {
                customer_id: customerId,
                order_id: order_id,
                entity_status: EntityStatus.ACTIVE,
            },
        });

        if (existingComment) {
            throw new BadRequestException('Vous avez déjà commenté cette commande');
        }

        // Créer le commentaire
        const comment = await this.prisma.comment.create({
            data: {
                message,
                rating,
                customer_id: customerId,
                order_id,
                entity_status: EntityStatus.ACTIVE,
            },
            include: {
                customer: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true,
                        phone: true,
                        image: true,
                    },
                },
                order: {
                    select: {
                        id: true,
                        reference: true,
                        created_at: true,
                    },
                },
            },
        });

        return this.mapToResponseDto(comment);
    }

    // Modifier un commentaire
    async updateComment(
        customerId: string,
        commentId: string,
        updateCommentDto: UpdateCommentDto,
    ): Promise<CommentResponseDto> {
        // Vérifier que le commentaire existe et appartient au client
        const existingComment = await this.prisma.comment.findFirst({
            where: {
                id: commentId,
                customer_id: customerId,
                entity_status: EntityStatus.ACTIVE,
            },
        });

        if (!existingComment) {
            throw new NotFoundException('Commentaire non trouvé ou non autorisé');
        }

        // Mettre à jour le commentaire
        const comment = await this.prisma.comment.update({
            where: { id: commentId },
            data: {
                ...updateCommentDto,
                updated_at: new Date(),
            },
            include: {
                customer: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true,
                        phone: true,
                        image: true,
                    },
                },
                order: {
                    select: {
                        id: true,
                        reference: true,
                        created_at: true,
                    },
                },
            },
        });

        return this.mapToResponseDto(comment);
    }

    // Supprimer un commentaire
    async deleteComment(commentId: string) {
        // Vérifier que le commentaire existe et appartient au client
        const existingComment = await this.prisma.comment.findFirst({
            where: {
                id: commentId,
                entity_status: EntityStatus.ACTIVE,
            },
        });

        if (!existingComment) {
            throw new NotFoundException('Commentaire non trouvé ou non autorisé');
        }

        // Soft delete
        const comment = await this.prisma.comment.update({
            where: { id: commentId },
            data: {
                entity_status: EntityStatus.DELETED,
                updated_at: new Date(),
            },
        });

        return this.mapToResponseDto(comment);
    }

    // Récupérer les commentaires d'une commande
    async getOrderComments(orderId: string, query: GetCommentsQueryDto): Promise<{
        comments: CommentResponseDto[];
        total: number;
        page: number;
        limit: number;
    }> {
        const { page = 1, limit = 10, min_rating = 1, max_rating = 5 } = query;
        const skip = (page - 1) * limit;

        const whereClause: any = {
            order_id: orderId,
            entity_status: EntityStatus.ACTIVE,
        };

        if (min_rating || max_rating) {
            whereClause.rating = {};
            if (min_rating) whereClause.rating.gte = min_rating;
            if (max_rating) whereClause.rating.lte = max_rating;
        }

        const [comments, total] = await Promise.all([
            this.prisma.comment.findMany({
                where: whereClause,
                include: {
                    customer: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            phone: true,
                            image: true,
                        },
                    },
                    order: {
                        select: {
                            id: true,
                            reference: true,
                            created_at: true,
                        },
                    },
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.comment.count({ where: whereClause }),
        ]);

        return {
            comments: comments.map(comment => this.mapToResponseDto(comment)),
            total,
            page,
            limit,
        };
    }

    // Récupérer les commentaires d'un plat
    async getDishComments(dishId: string, query: GetCommentsQueryDto): Promise<DishCommentsResponseDto> {
        const { page = 1, limit = 10, min_rating, max_rating } = query;
        const skip = (page - 1) * limit;

        // Récupérer le plat
        const dish = await this.prisma.dish.findFirst({
            where: {
                id: dishId,
                entity_status: EntityStatus.ACTIVE,
            },
        });

        if (!dish) {
            throw new NotFoundException('Plat non trouvé');
        }

        // Construire la clause WHERE pour les commentaires
        const whereClause: any = {
            entity_status: EntityStatus.ACTIVE,
            order: {
                entity_status: EntityStatus.ACTIVE,
                order_items: {
                    some: {
                        dish_id: dishId,
                    },
                },
            },
        };

        if (min_rating || max_rating) {
            whereClause.rating = {};
            if (min_rating) whereClause.rating.gte = min_rating;
            if (max_rating) whereClause.rating.lte = max_rating;
        }

        // Récupérer les commentaires des commandes contenant ce plat
        const comments = await this.prisma.comment.findMany({
            where: whereClause,
            include: {
                customer: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true,
                        phone: true,
                        image: true,
                    },
                },
                order: {
                    select: {
                        id: true,
                        reference: true,
                        created_at: true,
                    },
                },
            },
            orderBy: { created_at: 'desc' },
            skip,
            take: limit,
        });

        // Calculer les statistiques
        const allComments = await this.prisma.comment.findMany({
            where: whereClause,
            select: { rating: true },
        });

        const totalComments = allComments.length;
        const averageRating = totalComments > 0
            ? allComments.reduce((sum, comment) => sum + comment.rating, 0) / totalComments
            : 0;

        return {
            dish_id: dishId,
            dish_name: dish.name,
            total_comments: totalComments,
            average_rating: Math.round(averageRating * 10) / 10, // Arrondi à 1 décimale
            comments: comments.map(comment => this.mapToResponseDto(comment)),
        };
    }

    // Récupérer les commentaires d'un client
    async getCustomerComments(customerId: string, query: GetCommentsQueryDto): Promise<{
        comments: CommentResponseDto[];
        total: number;
        page: number;
        limit: number;
    }> {
        const { page = 1, limit = 10, min_rating, max_rating } = query;
        const skip = (page - 1) * limit;

        const whereClause: any = {
            customer_id: customerId,
            entity_status: EntityStatus.ACTIVE,
        };

        if (min_rating || max_rating) {
            whereClause.rating = {};
            if (min_rating) whereClause.rating.gte = min_rating;
            if (max_rating) whereClause.rating.lte = max_rating;
        }

        const [comments, total] = await Promise.all([
            this.prisma.comment.findMany({
                where: whereClause,
                include: {
                    customer: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            phone: true,
                            image: true,
                        },
                    },
                    order: {
                        select: {
                            id: true,
                            reference: true,
                            created_at: true,
                        },
                    },
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.comment.count({ where: whereClause }),
        ]);

        return {
            comments: comments.map(comment => this.mapToResponseDto(comment)),
            total,
            page,
            limit,
        };
    }

    // Récupérer un commentaire par ID
    async getCommentById(commentId: string): Promise<CommentResponseDto> {
        const comment = await this.prisma.comment.findFirst({
            where: {
                id: commentId,
                entity_status: EntityStatus.ACTIVE,
            },
            include: {
                customer: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true,
                        phone: true,
                        image: true,
                    },
                },
                order: {
                    select: {
                        id: true,
                        reference: true,
                        created_at: true,
                    },
                },
            },
        });

        if (!comment) {
            throw new NotFoundException('Commentaire non trouvé');
        }

        return this.mapToResponseDto(comment);
    }

    async getAllComments(query: GetCommentsQueryDto): Promise<QueryResponseDto<CommentResponseDto>> {
        const { page = 1, limit = 10, min_rating = 1, max_rating = 5 } = query;
        const skip = (page - 1) * limit;

        const whereClause: any = {
            entity_status: EntityStatus.ACTIVE,
        };

        if (min_rating || max_rating) {
            whereClause.rating = {};
            if (min_rating) whereClause.rating.gte = min_rating;
            if (max_rating) whereClause.rating.lte = max_rating;
        }

        if (query.restaurantId) {
            whereClause.order = {
                restaurant_id: query.restaurantId,
            };
        }

        const [comments, total] = await Promise.all([
            this.prisma.comment.findMany({
                where: whereClause,
                include: {
                    customer: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            phone: true,
                            image: true,
                        },
                    },
                    order: {
                        select: {
                            id: true,
                            reference: true,
                            created_at: true,
                        },
                    },
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.comment.count({ where: whereClause }),
        ]);

        return {
            data: comments.map(comment => this.mapToResponseDto(comment)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    // Mapper vers DTO de réponse
    private mapToResponseDto(comment: any): CommentResponseDto {
        return {
            id: comment.id,
            message: comment.message,
            rating: comment.rating,
            customer_id: comment.customer_id,
            order_id: comment.order_id,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            customer: comment.customer,
            order: comment.order,
        };
    }
}