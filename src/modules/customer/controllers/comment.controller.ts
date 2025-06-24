import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
    HttpCode,
    HttpStatus,
    Req,
    Patch,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { CommentService } from '../services/comment.service';
import {
    CreateCommentDto,
    UpdateCommentDto,
    CommentResponseDto,
    DishCommentsResponseDto,
    GetCommentsQueryDto,
} from '../dto/comment.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { Customer } from '@prisma/client';
import { Request } from 'express';

@ApiTags('Comments')
@Controller('comments')
export class CommentController {
    constructor(private readonly commentService: CommentService) { }

    @Post()
    @UseGuards(JwtCustomerAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Créer un commentaire' })
    @ApiResponse({ status: 201, description: 'Commentaire créé avec succès', type: CommentResponseDto })
    @ApiResponse({ status: 400, description: 'Données invalides' })
    @ApiResponse({ status: 404, description: 'Commande non trouvée' })
    async createComment(
        @Req() req: Request,
        @Body() createCommentDto: CreateCommentDto,
    ): Promise<CommentResponseDto> {
        const customer = req.user as Customer;
        return this.commentService.createComment(customer.id, createCommentDto);
    }

    @Patch(':id')
    @UseGuards(JwtCustomerAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Modifier un commentaire' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Commentaire modifié avec succès', type: CommentResponseDto })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    async updateComment(
        @Req() req: Request,
        @Param('id') commentId: string,
        @Body() updateCommentDto: UpdateCommentDto,
    ): Promise<CommentResponseDto> {
        const customer = req.user as Customer;
        return this.commentService.updateComment(customer.id, commentId, updateCommentDto);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Supprimer un commentaire' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 204, description: 'Commentaire supprimé avec succès' })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    async deleteComment(@Param('id') commentId: string): Promise<CommentResponseDto> {
        return this.commentService.deleteComment(commentId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Récupérer un commentaire par ID' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Commentaire trouvé', type: CommentResponseDto })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    async getCommentById(@Param('id') commentId: string): Promise<CommentResponseDto> {
        return this.commentService.getCommentById(commentId);
    }

    @Get('order/:orderId')
    @ApiOperation({ summary: 'Récupérer les commentaires d\'une commande' })
    @ApiParam({ name: 'orderId', description: 'ID de la commande' })
    @ApiQuery({ name: 'page', required: false, description: 'Numéro de page' })
    @ApiQuery({ name: 'limit', required: false, description: 'Nombre d\'éléments par page' })
    @ApiQuery({ name: 'min_rating', required: false, description: 'Note minimum' })
    @ApiQuery({ name: 'max_rating', required: false, description: 'Note maximum' })
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
    async getOrderComments(
        @Param('orderId') orderId: string,
        @Query() query: GetCommentsQueryDto,
    ) {
        return this.commentService.getOrderComments(orderId, query);
    }

    @Get('dish/:dishId')
    @ApiOperation({ summary: 'Récupérer les commentaires d\'un plat' })
    @ApiParam({ name: 'dishId', description: 'ID du plat' })
    @ApiQuery({ name: 'page', required: false, description: 'Numéro de page' })
    @ApiQuery({ name: 'limit', required: false, description: 'Nombre d\'éléments par page' })
    @ApiQuery({ name: 'min_rating', required: false, description: 'Note minimum' })
    @ApiQuery({ name: 'max_rating', required: false, description: 'Note maximum' })
    @ApiResponse({ status: 200, description: 'Commentaires du plat récupérés avec succès', type: DishCommentsResponseDto })
    @ApiResponse({ status: 404, description: 'Plat non trouvé' })
    async getDishComments(
        @Param('dishId') dishId: string,
        @Query() query: GetCommentsQueryDto,
    ): Promise<DishCommentsResponseDto> {
        return this.commentService.getDishComments(dishId, query);
    }

    @Get('customer/my-comments')
    @UseGuards(JwtCustomerAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Récupérer mes commentaires' })
    @ApiQuery({ name: 'page', required: false, description: 'Numéro de page' })
    @ApiQuery({ name: 'limit', required: false, description: 'Nombre d\'éléments par page' })
    @ApiQuery({ name: 'min_rating', required: false, description: 'Note minimum' })
    @ApiQuery({ name: 'max_rating', required: false, description: 'Note maximum' })
    @ApiResponse({
        status: 200,
        description: 'Mes commentaires récupérés avec succès',
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
    async getMyComments(
        @Req() req: Request,
        @Query() query: GetCommentsQueryDto,
    ) {
        const customer = req.user as Customer;
        console.log(customer)
        return this.commentService.getCustomerComments(customer.id, query);
    }

    @Get('customer/:customerId')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Récupérer les commentaires d\'un client (admin)' })
    @ApiParam({ name: 'customerId', description: 'ID du client' })
    @ApiQuery({ name: 'page', required: false, description: 'Numéro de page' })
    @ApiQuery({ name: 'limit', required: false, description: 'Nombre d\'éléments par page' })
    @ApiQuery({ name: 'min_rating', required: false, description: 'Note minimum' })
    @ApiQuery({ name: 'max_rating', required: false, description: 'Note maximum' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires du client récupérés avec succès',
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
    async getCustomerComments(
        @Param('customerId') customerId: string,
        @Query() query: GetCommentsQueryDto,
    ) {
        return this.commentService.getCustomerComments(customerId, query);
    }
    @Get()
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Récupérer tous les commentaires (admin)' })
    @ApiQuery({ name: 'page', required: false, description: 'Numéro de page' })
    @ApiQuery({ name: 'limit', required: false, description: 'Nombre d\'éléments par page' })
    @ApiQuery({ name: 'min_rating', required: false, description: 'Note minimum' })
    @ApiQuery({ name: 'max_rating', required: false, description: 'Note maximum' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires récupérés avec succès',
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
    async getAllComments(
        @Query() query: GetCommentsQueryDto,
    ) {
        return this.commentService.getAllComments(query);
    }
}