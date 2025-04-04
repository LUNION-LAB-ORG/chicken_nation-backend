import { Controller, Get, Post, Body, Param, Patch, UseGuards, Request } from '@nestjs/common';
import { PaymentsService } from '../services/payments.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { UpdatePaymentStatusDto } from '../dto/update-payment-status.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Payment } from '../entities/payment.entity';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiOperation({ summary: 'Récupérer tous les paiements', description: 'Accessible uniquement aux administrateurs' })
  @ApiResponse({ status: 200, description: 'Liste des paiements récupérée avec succès', type: [Payment] })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get()
  findAll(): Promise<Payment[]> {
    return this.paymentsService.findAll();
  }

  @ApiOperation({ summary: 'Récupérer les paiements de l\'utilisateur connecté' })
  @ApiResponse({ status: 200, description: 'Liste des paiements de l\'utilisateur récupérée avec succès', type: [Payment] })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @UseGuards(JwtAuthGuard)
  @Get('my-payments')
  getUserPayments(@Request() req): Promise<Payment[]> {
    return this.paymentsService.getUserPayments(req.user.userId);
  }

  @ApiOperation({ summary: 'Récupérer un paiement spécifique par ID' })
  @ApiParam({ name: 'id', description: 'ID du paiement à récupérer' })
  @ApiResponse({ status: 200, description: 'Paiement récupéré avec succès', type: Payment })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Paiement non trouvé' })
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string): Promise<Payment> {
    return this.paymentsService.findOne(id);
  }

  @ApiOperation({ summary: 'Créer un nouveau paiement' })
  @ApiBody({ type: CreatePaymentDto, description: 'Données du paiement à créer' })
  @ApiResponse({ status: 201, description: 'Paiement créé avec succès', type: Payment })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Commande non trouvée' })
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Request() req, @Body() createPaymentDto: CreatePaymentDto): Promise<Payment> {
    return this.paymentsService.create(req.user.userId, createPaymentDto);
  }

  @ApiOperation({ summary: 'Mettre à jour le statut d\'un paiement', description: 'Accessible uniquement aux administrateurs' })
  @ApiParam({ name: 'id', description: 'ID du paiement à mettre à jour' })
  @ApiBody({ type: UpdatePaymentStatusDto, description: 'Nouveau statut du paiement' })
  @ApiResponse({ status: 200, description: 'Statut du paiement mis à jour avec succès', type: Payment })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @ApiResponse({ status: 404, description: 'Paiement non trouvé' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() updatePaymentStatusDto: UpdatePaymentStatusDto,
  ): Promise<Payment> {
    return this.paymentsService.updateStatus(id, updatePaymentStatusDto);
  }
}