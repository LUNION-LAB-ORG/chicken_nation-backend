import { Controller, Get, Post, Body, Param, Patch, UseGuards, Request } from '@nestjs/common';
import { MobileMoneyService } from '../services/mobile-money.service';
import { MobileMoneyPaymentDto } from '../dto/mobile-money-payment.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { MobileMoneyTransaction, MobileMoneyTransactionStatus } from '../entities/mobile-money-transaction.entity';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';

@ApiTags('mobile-money')
@ApiBearerAuth()
@Controller('payments/mobile-money')
export class MobileMoneyController {
  constructor(private readonly mobileMoneyService: MobileMoneyService) {}

  @ApiOperation({ summary: 'Récupérer toutes les transactions Mobile Money', description: 'Accessible uniquement aux administrateurs' })
  @ApiResponse({ status: 200, description: 'Liste des transactions récupérée avec succès', type: [MobileMoneyTransaction] })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get()
  findAll(): Promise<MobileMoneyTransaction[]> {
    return this.mobileMoneyService.findAll();
  }

  @ApiOperation({ summary: 'Récupérer une transaction Mobile Money spécifique par ID' })
  @ApiParam({ name: 'id', description: 'ID de la transaction à récupérer' })
  @ApiResponse({ status: 200, description: 'Transaction récupérée avec succès', type: MobileMoneyTransaction })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Transaction non trouvée' })
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string): Promise<MobileMoneyTransaction> {
    return this.mobileMoneyService.findOne(id);
  }

  @ApiOperation({ summary: 'Récupérer les transactions Mobile Money pour une commande spécifique' })
  @ApiParam({ name: 'orderId', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Transactions récupérées avec succès', type: [MobileMoneyTransaction] })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @UseGuards(JwtAuthGuard)
  @Get('order/:orderId')
  findByOrderId(@Param('orderId') orderId: string): Promise<MobileMoneyTransaction[]> {
    return this.mobileMoneyService.findByOrderId(orderId);
  }

  @ApiOperation({ summary: 'Créer un nouveau paiement Mobile Money' })
  @ApiBody({ type: MobileMoneyPaymentDto, description: 'Données du paiement Mobile Money à créer' })
  @ApiResponse({ status: 201, description: 'Paiement Mobile Money créé avec succès', type: MobileMoneyTransaction })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Commande non trouvée' })
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Request() req, @Body() mobileMoneyPaymentDto: MobileMoneyPaymentDto): Promise<MobileMoneyTransaction> {
    return this.mobileMoneyService.create(req.user.userId, mobileMoneyPaymentDto);
  }

  @ApiOperation({ summary: 'Mettre à jour le statut d\'une transaction Mobile Money', description: 'Accessible uniquement aux administrateurs' })
  @ApiParam({ name: 'id', description: 'ID de la transaction à mettre à jour' })
  @ApiBody({ description: 'Nouveau statut de la transaction et réponse du fournisseur' })
  @ApiResponse({ status: 200, description: 'Statut de la transaction mis à jour avec succès', type: MobileMoneyTransaction })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @ApiResponse({ status: 404, description: 'Transaction non trouvée' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: { status: MobileMoneyTransactionStatus; providerResponse?: Record<string, any> },
  ): Promise<MobileMoneyTransaction> {
    return this.mobileMoneyService.updateStatus(id, updateStatusDto.status, updateStatusDto.providerResponse);
  }
}
