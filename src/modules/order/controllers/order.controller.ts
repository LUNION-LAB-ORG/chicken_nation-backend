import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { UserScopedCacheInterceptor } from '../interceptors/user-scoped-cache.interceptor';
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
  Res,
  UseGuards,
  UseInterceptors, NotFoundException, ForbiddenException } from '@nestjs/common';
import {
  assertCanAccessRestaurant,
  resolveRestaurantScope,
} from '../helpers/restaurant-scope.helper';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags
} from '@nestjs/swagger';
import { Customer, OrderStatus, User, UserRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { ConfirmPaymentDto } from 'src/modules/order/dto/confirm-payment.dto';
import { KkiapayOrderListenerService } from '../listeners/kkiapay-order.listener.service';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { MarkPaidCashDto } from 'src/modules/order/dto/mark-paid-cash.dto';
import { QueryOrderCustomerDto, QueryOrderDto } from 'src/modules/order/dto/query-order.dto';
import { OrderUpdatedDto, UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { OrderService } from 'src/modules/order/services/order.service';
import { FraisLivraisonDto } from '../dto/frais-livrasion.dto';
import { ReceiptsService } from '../services/receipts.service';
import { OrderCreateDto } from '../dto/order-create.dto';
import { OrderWebSocketService } from '../websockets/order-websocket.service';

@ApiTags('Commandes')
@Controller('orders')
@UseInterceptors(UserScopedCacheInterceptor)
export class OrderController {
  constructor(
    private readonly kkiapayService: KkiapayService,
    private readonly orderService: OrderService,
    private readonly receiptsService: ReceiptsService,
    private readonly orderWebSocketService: OrderWebSocketService,
    private readonly kkiapayOrderListenerService: KkiapayOrderListenerService,
  ) { }

  /**
   * Création de commande par un CLIENT (ancienne route, encore utilisée par les
   * applications installées avant `/create-v2`).
   *
   * ⚠️ FAILLE FERMÉE (10/08). Cette route partage son traitement avec la route
   * du centre d'appel `/orders/create`, qui est réservée au personnel. Le corps
   * de requête portait donc des champs de personnel que le client contrôlait :
   *
   *  - `delivery_fee` : un client qui postait 0 se faisait livrer gratuitement
   *    (c'est la cause des commandes à 0 franc de frais rattrapées le 06/08) ;
   *  - `user_id` : renseigné, il annule la TVA, bascule le paiement en espèces
   *    et passe la commande en ACCEPTED sans qu'un franc soit encaissé ;
   *  - `customer_id` : librement choisi, il permettait de commander au nom d'un
   *    autre client, avec ses points de fidélité.
   *
   * On neutralise ces trois champs ici plutôt que dans le service, pour que la
   * route du personnel garde ses prérogatives légitimes.
   */
  @Post()
  @UseGuards(JwtCustomerAuthGuard) // client peut créer ses propres commandes
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  async create(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    const client = req.user as Customer;
    return this.orderService.create(req, {
      ...createOrderDto,
      // Le client commande pour LUI, quoi qu'annonce le corps de la requête.
      customer_id: client.id,
      // Frais de livraison et exonération de TVA : décisions du personnel.
      delivery_fee: undefined,
      user_id: undefined,
    });
  }
  @Post("/create-v2")
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: OrderCreateDto })
  async createorderv2(@Req() req: Request, @Body() createOrderDto: OrderCreateDto) {
    const customer_id = (req.user as Customer).id;
    const order = await this.orderService.createv2(customer_id, createOrderDto);
    return this.attachPaymentConfig(order);
  }

  /**
   * MULTI-COMPTES KKiaPay : embarque la configuration PUBLIQUE de paiement du
   * restaurant de la commande (clé publique + sandbox — jamais de secret) dans
   * les réponses destinées à l'app. La commande étant créée AVANT le paiement,
   * l'app n'a AUCUN appel supplémentaire à faire — indispensable en livraison,
   * où c'est le serveur qui affecte le restaurant. Ne casse jamais la réponse :
   * en cas d'échec de résolution, la commande part sans bloc `payment` et
   * l'app retombe sur sa clé embarquée (compte global).
   */
  private async attachPaymentConfig<T extends { restaurant_id?: string | null }>(order: T) {
    try {
      const payment = await this.kkiapayService.getPublicPaymentConfig(
        order?.restaurant_id ?? null,
      );
      return { ...order, payment };
    } catch {
      return order;
    }
  }


  @Post("/create")
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  async createBackoffice(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @ApiOperation({ summary: 'Rechercher toutes les commandes' })
  findAll(@Req() req: Request, @Query() queryOrderDto: QueryOrderDto) {
    // Le user du JWT pilote la visibilité PENDING (admin seul) côté service.
    return this.orderService.findAll(queryOrderDto, req.user as User);
  }

  @Post(':id/mark-paid-cash')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiOperation({
    summary: 'Caissière : encaisse le livreur pour une commande en espèce',
    description:
      'Marque Order.paied=true + paied_at=now et passe en COMPLETED. Uniquement pour payment_method=OFFLINE. Déclenche order:updated.',
  })
  @ApiBody({ type: MarkPaidCashDto })
  markPaidCash(@Param('id') id: string, @Body() dto: MarkPaidCashDto) {
    return this.orderService.markPaidCash(id, dto.amount);
  }

  @Post(':id/confirm-payment')
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  // ADMIN STRICTEMENT : confirmer un paiement en ligne à la main est sensible
  // (déclenche points/récompense/parrainage). Même schéma de garde que les autres
  // routes admin-only du repo (cf. DeliverersAdminController).
  @UserRoles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Admin : confirmer manuellement un paiement KKiaPay resté PENDING',
    description:
      'Rejoue le MÊME chemin que le webhook : re-vérifie la transaction auprès de ' +
      'KKiaPay (verifyTransaction) et ne confirme QUE si SUCCESS + montant couvert, ' +
      'puis passe la commande PENDING→ACCEPTED, enregistre le paiement et crédite ' +
      'points/récompense/parrainage. Idempotent. Aucun « force » : impossible de ' +
      'marquer payé sans un verify KKiaPay positif.',
  })
  @ApiBody({ type: ConfirmPaymentDto })
  @ApiResponse({ status: 201, description: 'Paiement confirmé ({ confirmed, order, paiement })' })
  @ApiResponse({ status: 400, description: 'Commande non ONLINE / déjà traitée, ou verify KKiaPay négatif (motif dans message)' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  async confirmPayment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ConfirmPaymentDto,
  ) {
    const result = await this.kkiapayOrderListenerService.confirmPaymentManually(
      id,
      dto.transactionId,
    );
    // Cloisonnement resto (no-op pour un ADMIN, de type BACKOFFICE) — cohérent avec
    // les autres endpoints « détail par id ». La garde de rôle reste la barrière réelle.
    assertCanAccessRestaurant(
      req.user as User,
      (result.order as { restaurant_id?: string | null })?.restaurant_id,
    );
    return result;
  }

  @Get('/operations/active')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @ApiOperation({
    summary: 'Liste des commandes actives pour la page Opérations',
    description: 'ACCEPTED, IN_PROGRESS, READY, PICKED_UP, COLLECTED — avec Delivery/Course si applicable.',
  })
  operationsActive(
    @Req() req: Request,
    @Query('restaurantId') restaurantId?: string,
  ) {
    // Cloisonnement : un user RESTAURANT est forcé à SON restaurant (le param
    // est ignoré) ; un user BACKOFFICE filtre librement via l'onglet.
    const scope = resolveRestaurantScope(req.user as User, restaurantId);
    return this.orderService.findActiveForOperations(scope);
  }

  @Get('/customer')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Rechercher commandes d’un client' })
  async findAllByCustomer(
    @Req() req: Request,
    @Query() queryOrderDto: QueryOrderCustomerDto,
  ) {
    const result = await this.orderService.findAllByCustomer(req, queryOrderDto);
    // Relance de paiement depuis la LISTE (ActionRequiredCard) : chaque commande
    // embarque la config publique de paiement de son restaurant. resolveAccount
    // est mémoïsé 60 s → coût négligeable sur une page de commandes.
    if (Array.isArray((result as any)?.data)) {
      (result as any).data = await Promise.all(
        (result as any).data.map((o: any) => this.attachPaymentConfig(o)),
      );
    }
    return result;
  }

  @Get('/statistics')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @ApiOperation({ summary: 'Statistiques des commandes' })
  getOrderStatistics(
    @Req() req: Request,
    @Query() queryOrderDto: QueryOrderDto,
  ) {
    // Même cloisonnement que les opérations : un caissier ne voit QUE les stats
    // de son restaurant, jamais celles du réseau.
    const restaurantId = resolveRestaurantScope(
      req.user as User,
      queryOrderDto.restaurantId,
    );
    return this.orderService.getOrderStatistics({
      ...queryOrderDto,
      restaurantId,
    });
  }

  @Get('/export-report-to-excel')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.EXPORT)
  @ApiOperation({ summary: 'Exporter un rapport des commandes' })
  @ApiResponse({ status: 200, description: 'Rapport des commandes exporté avec succès' })
  async exportOrderReportToExcel(@Query() query: QueryOrderDto, @Res() res: Response) {
    const { buffer, filename } = await this.orderService.exportOrderReportToExcel(query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);

    res.status(HttpStatus.OK).send(buffer);
  }

  @Get('/export-delivery-pivot')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.EXPORT)
  @ApiOperation({ summary: 'Exporter le pivot livraisons par restaurant' })
  async exportDeliveryPivot(@Query() query: QueryOrderDto, @Res() res: Response) {
    const { buffer, filename } = await this.orderService.exportDeliveryPivotToExcel(query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);

    res.status(HttpStatus.OK).send(buffer);
  }

  @Post('/backfill-delivery-fees')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiOperation({
    summary:
      'RATTRAPAGE : recalcule le frais plein (grille) des commandes livrées à base 0 — dry-run par défaut, ?apply=true pour écrire. Ne touche jamais aux montants clients.',
  })
  backfillDeliveryFees(
    @Query('apply') apply?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orderService.backfillDeliveryFees({
      dryRun: apply !== 'true',
      startDate,
      endDate,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('/export-deliveries')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.EXPORT)
  @ApiOperation({ summary: 'Exporter les livraisons (frais base/remise/facturé + infos Turbo)' })
  async exportDeliveries(@Req() req: Request, @Query() query: QueryOrderDto, @Res() res: Response) {
    const { buffer, filename } = await this.orderService.exportDeliveriesToExcel(query, req.user as User);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);

    res.status(HttpStatus.OK).send(buffer);
  }

  @Post('/refresh')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Émettre un événement de rafraîchissement des commandes' })
  @ApiResponse({ status: 200, description: 'Événement de rafraîchissement émis' })
  refresh() {
    this.orderWebSocketService.emitOrderRefresh();
    return { success: true, message: 'Rafraîchissement des commandes émis' };
  }

  /**
   * GET /orders/itineraire-livraison
   *
   * Le restaurant retenu, les frais et le trajet, en une seule requête, pour
   * la page qui fait vérifier son adresse au client avant qu'il paie.
   * Doit rester AVANT `@Get(':id')`, sinon Nest prend « itineraire-livraison »
   * pour un identifiant de commande.
   */
  @Get('/itineraire-livraison')
  @ApiOperation({ summary: "Itinéraire du restaurant retenu jusqu'à l'adresse" })
  async obtenirItineraireLivraison(@Query() params: FraisLivraisonDto) {
    return this.orderService.obtenirItineraireLivraison(params);
  }

  @Get('/frais-livraison')
  @ApiOperation({ summary: 'Obtenir le prix des frais de livraison' })
  @ApiResponse({
    status: 200,
    description: 'Frais de livraison obtenus avec succès',
  })
  @ApiBody({ type: FraisLivraisonDto })
  async obtenirFraisLivraison(@Query() params: FraisLivraisonDto) {
    return this.orderService.obtenirFraisLivraison(params);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  async findOne(@Req() req: Request, @Param('id') id: string) {
    const order = await this.orderService.findById(id);
    // Un user RESTAURANT ne peut pas ouvrir la commande d'un autre restaurant
    // (même en devinant l'id). Le BACKOFFICE n'est pas restreint.
    assertCanAccessRestaurant(
      req.user as User,
      (order as { restaurant_id?: string | null })?.restaurant_id,
    );
    return order;
  }
  @Get(':id/client')
  @UseGuards(JwtCustomerAuthGuard)
  async findOneClient(@Req() req: Request, @Param('id') id: string) {
    // Chemin de RELANCE de paiement (ActionRequiredCard) : embarque aussi la
    // config de paiement du restaurant.
    const order = await this.orderService.findById(id);
    // OWNERSHIP (revue 31/07) : tout client authentifié pouvait lire la
    // commande de n'importe qui (adresse, téléphone, contenu) en énumérant
    // des ids. 404 — pas 403 — pour ne pas confirmer l'existence de l'id.
    const customerId = (req.user as Customer)?.id;
    if (!order || (order as any).customer_id !== customerId) {
      throw new NotFoundException('Commande introuvable');
    }
    return this.attachPaymentConfig(order);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiBody({ type: UpdateOrderDto })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateOrderDto: UpdateOrderDto,
  ) {
    // ADMIN bypass : peut modifier une commande quel que soit son statut
    // (COMPLETED, COLLECTED, CANCELLED inclus). Cf. order.service.ts:update().
    const user = req.user as User;
    const isAdmin = user?.role === UserRole.ADMIN;
    return this.orderService.update(id, updateOrderDto, {
      skipStatusCheck: isAdmin,
      userId: user.id,
    });
  }
  /**
   * ⚠️ FAILLE CRITIQUE CORRIGEE : aucun contrôle d'appartenance.
   *
   * L'identifiant venait de l'URL et n'était jamais confronté au client du
   * jeton. Avec un compte créé en trente secondes et l'identifiant d'une
   * commande tierce, on réécrivait l'adresse de livraison, le téléphone ou le
   * restaurant d'une commande payée par quelqu'un d'autre : la livraison
   * partait chez l'attaquant.
   *
   * Le contrôle est celui, déjà écrit, de la route de LECTURE juste au dessus :
   * la version écriture ne l'avait jamais reçu.
   */
  @Patch(':id/client')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiBody({ type: OrderUpdatedDto })
  async updateClient(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() orderUpdatedDto: OrderUpdatedDto,
  ) {
    await this.assertCommandeDuClient(req, id);
    /**
     * ⚠️ Le STATUT n'est pas modifiable depuis ce chemin.
     *
     * `updateClient` faisait passer la commande de PENDING à ACCEPTED sans
     * jamais regarder si elle était payée. Or le paiement client pose
     * seulement `paied`, en laissant volontairement le statut à PENDING : un
     * client pouvait donc valider lui même une commande en ligne NON PAYEE.
     * L'annulation reste possible par la route de statut dédiée.
     */
    const { status, ...champsClient } = orderUpdatedDto as any;
    return this.orderService.updateClient(id, champsClient);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: Object.values(OrderStatus) },
        meta: { type: 'object', additionalProperties: true },
      },
      required: ['status'],
    },
  })
  async updateStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { status: OrderStatus; meta?: Record<string, any> },
  ) {
    const user = req.user as User;
    /**
     * ⚠️ Cloisonnement RESTAURANT. La permission était vérifiée, mais pas le
     * périmètre : un caissier du restaurant A pouvait faire avancer, ou
     * ANNULER, une commande du restaurant B — et l'annulation déclenche un
     * remboursement réel. Le contrôle existait déjà sur la lecture.
     */
    const commande = await this.orderService.findById(id);
    if (!commande) throw new NotFoundException('Commande introuvable');
    assertCanAccessRestaurant(user, (commande as any).restaurant_id);
    // On transmet le rôle : seul un ADMIN pourra annuler une commande déjà avancée.
    return this.orderService.updateStatus(id, body.status, {
      ...body.meta,
      userId: user.id,
      role: user.role,
    });
  }

  @Patch(':id/client/status')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: Object.values(OrderStatus) },
        meta: { type: 'object', additionalProperties: true },
      },
      required: ['status'],
    },
  })
  async updateStatusClient(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { status: OrderStatus; meta?: Record<string, any> },
  ) {
    /**
     * ⚠️ FAILLE CRITIQUE CORRIGEE : aucun contrôle d'appartenance, et aucune
     * restriction de statut.
     *
     * Tout client authentifié connaissant l'identifiant d'une commande tierce
     * pouvait poser CANCELLED, ce qui déclenche un VRAI remboursement KKiaPay
     * du paiement de la victime, ou faire AVANCER la commande d'autrui étape
     * par étape et saboter le service du restaurant.
     */
    await this.assertCommandeDuClient(req, id);

    /**
     * ⚠️ Un client ne pose QUE l'annulation. Faire avancer une commande est un
     * geste de restaurant, jamais de client : la transition était pourtant
     * ouverte à tous les statuts. La légitimité de l'annulation elle même
     * (statut de départ) reste tranchée par le service.
     */
    if (body.status !== OrderStatus.CANCELLED) {
      throw new ForbiddenException(
        "Seule l'annulation de votre commande est possible depuis l'application",
      );
    }

    const userId = (req.user as Customer).id;
    return this.orderService.updateStatus(id, body.status, { ...body.meta, userId });
  }

  /**
   * Refuse l'accès si la commande n'appartient pas au client du jeton.
   *
   * On répond « introuvable » et non « interdit » : confirmer l'existence d'un
   * identifiant permettrait de les énumérer.
   */
  private async assertCommandeDuClient(req: Request, orderId: string) {
    const order = await this.orderService.findById(orderId);
    const customerId = (req.user as Customer)?.id;
    if (!order || (order as any).customer_id !== customerId) {
      throw new NotFoundException('Commande introuvable');
    }
    return order;
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.DELETE)
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }

  @Get(':id/pdf')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.EXPORT)
  async getReceiptPdf(@Param('id') id: string, @Res() res: Response) {
    await this.receiptsService.generateReceiptPdf(id, res);
  }
}
