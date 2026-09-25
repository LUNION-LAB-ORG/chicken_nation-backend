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
import { Customer, User } from '@prisma/client';
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
import { RestaurantQueryScopeGuard } from 'src/common/guards/restaurant-query-scope.guard';
import { resolveRestaurantScope } from 'src/modules/order/helpers/restaurant-scope.helper';
import { UserScopedCacheInterceptor } from 'src/modules/order/interceptors/user-scoped-cache.interceptor';

/**
 * ⚠️ Cache CLOISONNÉ par utilisateur, et non le `CacheInterceptor` par URL.
 * Avec une clé réduite à l'URL, la liste « tous restaurants » d'un admin était
 * resservie à un manager, et « mes avis » d'un client à un autre client.
 */
@ApiTags('Comments')
@Controller('comments')
@UseInterceptors(UserScopedCacheInterceptor)
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
    // ⚠️ Sans garde, n'importe qui pouvait supprimer un avis. Le
  // @ApiBearerAuth documentait un jeton que RIEN ne vérifiait.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.DELETE)
  @Delete(':id')
    async deleteComment(@Param('id') commentId: string): Promise<CommentResponseDto> {
        return this.commentService.deleteComment(commentId);
    }

    // Route PUBLIQUE du site vitrine (section « Témoignages ») : prénom et
    // initiale du nom seulement, jamais téléphone, e-mail, photo ni commande.
    @ApiOperation({ summary: 'Récupérer les meilleurs commentaires' })
    @ApiResponse({
        status: 200,
        description: 'Commentaires récupérés avec succès',
    })
    @Get('bests')
    async getBestComments(@Query() query: GetCommentsQueryDto) {
        return this.commentService.getBestComments(query);
    }

    @ApiOperation({
        summary: "Curation site (staff) : afficher ou retirer un avis de la section Témoignages",
    })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Visibilité mise à jour' })
    // ⚠️ Aucune permission : tout membre du personnel réécrivait ou publiait un avis client.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.UPDATE)
  @Patch(':id/site-visible')
    async setSiteVisible(
        @Param('id') commentId: string,
        @Body() body: { visible: boolean },
    ) {
        return this.commentService.setSiteVisible(commentId, body?.visible === true);
    }

    @ApiOperation({
        summary: "Correction staff : modifier le TEXTE d'un avis (faute de frappe…) — la note n'est jamais modifiée",
    })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Message corrigé' })
    // ⚠️ Aucune permission : tout membre du personnel réécrivait ou publiait un avis client.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.UPDATE)
  @Patch(':id/message')
    async updateMessageAsStaff(
        @Param('id') commentId: string,
        @Body() body: { message: string },
    ) {
        return this.commentService.updateMessageAsStaff(commentId, body?.message ?? '');
    }

    @ApiOperation({ summary: 'Récupérer un commentaire par ID' })
    @ApiParam({ name: 'id', description: 'ID du commentaire' })
    @ApiResponse({ status: 200, description: 'Commentaire trouvé', type: CommentResponseDto })
    @ApiResponse({ status: 404, description: 'Commentaire non trouvé' })
    // ⚠️ Route sans aucune garde : sans jeton, elle donnait nom, téléphone,
    // photo et commande de l'auteur de n'importe quel avis, les identifiants
    // d'avis étant publics. Aucun écran ne l'appelle. Réservée au personnel ;
    // un compte de restaurant ne lit que les avis de SON restaurant.
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.COMMENTAIRES, Action.READ)
    @Get(':id')
    async getCommentById(
        @Req() req: Request,
        @Param('id') commentId: string,
    ): Promise<CommentResponseDto> {
        return this.commentService.getCommentById(
            commentId,
            resolveRestaurantScope(req.user as User),
        );
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
    // ⚠️ Route sans aucune garde : n'importe qui lisait les avis d'une commande
    // arbitraire, avec l'identité du client. Réservée au personnel, les avis
    // publics restant servis par la route « par plat ».
    // Personnel de restaurant : 403 pour une commande d'un autre restaurant.
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.COMMENTAIRES, Action.READ)
    @Get('order/:orderId')
    async getOrderComments(
        @Req() req: Request,
        @Param('orderId') orderId: string,
        @Query() query: GetCommentsQueryDto,
    ) {
        return this.commentService.getOrderComments(
            orderId,
            query,
            resolveRestaurantScope(req.user as User),
        );
    }


    @ApiOperation({ summary: 'Récupérer les commentaires d\'un plat' })
    @ApiParam({ name: 'dishId', description: 'ID du plat' })
    @ApiResponse({ status: 200, description: 'Commentaires du plat récupérés avec succès', type: DishCommentsResponseDto })
    @ApiResponse({ status: 404, description: 'Plat non trouvé' })
    // ⚠️ Route publique sans plafond : ?limit=100000 sur chaque plat donnait
    // nom, photo, identifiant client et référence de commande de tous les
    // auteurs d'avis. Seuls la fiche plat du backoffice et celle de la caisse
    // l'appellent, avec un jeton du personnel (ni l'application ni le site).
    // MENUS READ et non COMMENTAIRES READ : l'assistant manager et le comptable
    // voient l'onglet sans avoir les avis. Un compte de restaurant ne voit que
    // les avis de SON restaurant, comme sur GET /comments.
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.MENUS, Action.READ)
    @Get('dish/:dishId')
    async getDishComments(
        @Req() req: Request,
        @Param('dishId') dishId: string,
        @Query() query: GetCommentsQueryDto,
    ): Promise<DishCommentsResponseDto> {
        return this.commentService.getDishComments(
            dishId,
            query,
            resolveRestaurantScope(req.user as User),
        );
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

    
    // Personnel de restaurant : seulement les avis laissés sur les commandes de
    // SON restaurant (restaurant forcé depuis le jeton, jamais depuis la requête).
    @Get('customer/:customerId')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
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
        return this.commentService.getCustomerComments(customerId, query, query.restaurantId);
    }


    // Personnel de restaurant (manager, caissier…) : `restaurantId` est forcé
    // au restaurant du jeton par RestaurantQueryScopeGuard, même omis ou
    // falsifié. Le backoffice garde le filtre libre.
    @Get()
    @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
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