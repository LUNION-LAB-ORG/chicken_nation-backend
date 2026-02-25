import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Customer } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import {
    CommentResponseDto,
    CreateCommentDto,
    DishCommentsResponseDto,
    GetCommentsQueryDto,
    UpdateCommentDto,
} from '../dto/comment.dto';
import { CommentService } from '../services/comment.service';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

@ApiTags('Comments')
@Controller('comments')
@UseInterceptors(CacheInterceptor)
export class CommentController {
    constructor(private readonly commentService: CommentService) { }

    @UseGuards(JwtCustomerAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Créer un commentaire' })
    @ApiResponse({ status: 201, description: 'Commentaire créé avec succès', type: CommentResponseDto })
    @ApiResponse({ status: 400, description: 'Données invalides' })
    @ApiResponse({ status: 404, description: 'Commande non trouvée' })
    @Post()
    async createComment(
        @Req() req: Request,
        @Body() createCommentDto: CreateCommentDto,
    ): Promise<CommentResponseDto> {
        const customer = req.user as Customer;
        return this.commentService.createComment(customer.id, createCommentDto);
    }

    @UseGuards(JwtCustomerAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Modifier un commentaire' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Commentaire modifié avec succès', type: CommentResponseDto })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    @Patch(':id')
    async updateComment(
        @Req() req: Request,
        @Param('id') commentId: string,
        @Body() updateCommentDto: UpdateCommentDto,
    ): Promise<CommentResponseDto> {
        const customer = req.user as Customer;
        return this.commentService.updateComment(customer.id, commentId, updateCommentDto);
    }


    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Supprimer un commentaire' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 204, description: 'Commentaire supprimé avec succès' })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    @Delete(':id')
    async deleteComment(@Param('id') commentId: string): Promise<CommentResponseDto> {
        return this.commentService.deleteComment(commentId);
    }

    @ApiOperation({ summary: 'Récupérer les meilleurs commentaires' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires récupérés avec succès',
    })

    @Get('bests')
    async getBestComments(@Query() query: GetCommentsQueryDto) {
        return this.commentService.getBestComments(query);
    }

    @ApiOperation({ summary: 'Récupérer un commentaire par ID' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Commentaire trouvé', type: CommentResponseDto })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    @Get(':id')
    async getCommentById(@Param('id') commentId: string): Promise<CommentResponseDto> {
        return this.commentService.getCommentById(commentId);
    }

    @ApiOperation({ summary: 'Récupérer les commentaires d\'une commande' })
    @ApiParam({ name: 'orderId', description: 'ID de la commande' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires de la commande récupérés avec succès',
        schema: {
            type: 'object',
            properties: {
                comments: { type: 'array', items: { $ref: '#/components/schemas/CommentResponseDto' } },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
            },
        },
    })
    @Get('order/:orderId')
    async getOrderComments(
        @Param('orderId') orderId: string,
        @Query() query: GetCommentsQueryDto,
    ) {
        return this.commentService.getOrderComments(orderId, query);
    }


    @ApiOperation({ summary: 'Récupérer les commentaires d\'un plat' })
    @ApiParam({ name: 'dishId', description: 'ID du plat' })
    @ApiResponse({ status: 200, description: 'Commentaires du plat récupérés avec succès', type: DishCommentsResponseDto })
    @ApiResponse({ status: 404, description: 'Plat non trouvé' })
    @Get('dish/:dishId')
    async getDishComments(
        @Param('dishId') dishId: string,
        @Query() query: GetCommentsQueryDto,
    ): Promise<DishCommentsResponseDto> {
        return this.commentService.getDishComments(dishId, query);
    }


    @Get('customer/my-comments')
    @UseGuards(JwtCustomerAuthGuard)
    @ApiOperation({ summary: 'Récupérer mes commentaires' })
    @ApiResponse({
        status: 200,
        description: 'Mes commentaires récupérés avec succès',
    })
    async getMyComments(
        @Req() req: Request,
        @Query() query: GetCommentsQueryDto,
    ) {
        const customer = req.user as Customer;
        return this.commentService.getCustomerComments(customer.id, query);
    }

    
    @Get('customer/:customerId')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.COMMENTAIRES, Action.READ)
    @ApiOperation({ summary: 'Récupérer les commentaires d\'un client (admin)' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires du client récupérés avec succès',
    })
    async getCustomerComments(
        @Param('customerId') customerId: string,
        @Query() query: GetCommentsQueryDto,
    ) {
        return this.commentService.getCustomerComments(customerId, query);
    }


    @Get()
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.COMMENTAIRES, Action.READ)
    @ApiOperation({ summary: 'Récupérer tous les commentaires (admin)' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires récupérés avec succès',

    })
    async getAllComments(@Query() query: GetCommentsQueryDto) {
        return this.commentService.getAllComments(query);
    }

}