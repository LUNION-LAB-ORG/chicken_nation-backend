import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Customer, OrderChannel, OrderStatus, PaymentMethod } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { PaiementEnLigneService, compatiblePaystack } from 'src/paystack/paiement-en-ligne.service';
import { REFERENCE_TENTATIVE } from 'src/paystack/paystack.rules';
import { PaystackService } from 'src/paystack/paystack.service';
import { callbackAppli, callbackSite, lienProfondAccepte } from 'src/paystack/retour-paiement.rules';
import { KkiapayOrderListenerService } from '../listeners/kkiapay-order.listener.service';

/** Au-delà, une commande ne lance plus de nouveau paiement (page ouverte en boucle). */
const TENTATIVES_MAX_PAR_COMMANDE = 15;

const canalDe = (req: Request): 'APP' | 'WEB' =>
  String(req.headers['x-canal-commande'] ?? '').toLowerCase() === 'web' ? 'WEB' : 'APP';

/**
 * PAIEMENT EN LIGNE CÔTÉ CLIENT (25/11), appli et site.
 *
 *  - `GET  /paiement-en-ligne/disponibilite` : l'option « payer en ligne »
 *    est-elle proposée (réglage du back-office, version de l'appli,
 *    sous-compte du restaurant) ;
 *  - `POST /paiement-en-ligne/paystack/initialiser` : lance la page de
 *    paiement Paystack d'une commande du client ;
 *  - `POST /paiement-en-ligne/paystack/verifier` : au retour du client,
 *    revérifie chez Paystack et confirme la commande (le webhook fait de même).
 */
@Controller('paiement-en-ligne')
export class PaiementEnLigneController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paiementEnLigne: PaiementEnLigneService,
    private readonly paystack: PaystackService,
    private readonly listener: KkiapayOrderListenerService,
  ) {}

  @Get('disponibilite')
  @ApiOperation({ summary: 'Le paiement en ligne est-il proposé (pour ce restaurant) ?' })
  async disponibilite(@Req() req: Request, @Query('restaurant_id') restaurantId?: string) {
    return this.paiementEnLigne.disponibilite({
      restaurantId: restaurantId && isUUID(restaurantId) ? restaurantId : null,
      compatiblePaystack: compatiblePaystack(req.headers['x-app-paiements']),
    });
  }

  @Post('paystack/initialiser')
  @UseGuards(JwtCustomerAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: "Lance le paiement Paystack d'une commande du client" })
  async initialiser(@Req() req: Request, @Body() body: { order_id?: string; retour?: string }) {
    const client = req.user as Customer;
    const orderId = body?.order_id;
    if (typeof orderId !== 'string' || !isUUID(orderId)) throw new BadRequestException('Commande invalide.');
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        reference: true,
        amount: true,
        restaurant_id: true,
        customer_id: true,
        email: true,
        status: true,
        paied: true,
        payment_method: true,
        entity_status: true,
        channel: true,
        customer: { select: { email: true } },
      },
    });
    // Commande d'un autre client : 404, comme si elle n'existait pas.
    if (!order || order.customer_id !== client.id || order.entity_status === 'DELETED') {
      throw new NotFoundException('Commande introuvable.');
    }
    if (order.paied) throw new BadRequestException('Cette commande est déjà payée.');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException("Cette commande n'attend plus de paiement.");
    }
    if (order.payment_method !== PaymentMethod.ONLINE) {
      throw new BadRequestException("Cette commande ne se paie pas en ligne.");
    }

    const disponibilite = await this.paiementEnLigne.disponibilite({
      restaurantId: order.restaurant_id,
      compatiblePaystack: compatiblePaystack(req.headers['x-app-paiements']),
    });
    if (!disponibilite.disponible) throw new BadRequestException(disponibilite.message);
    if (disponibilite.fournisseur !== 'paystack') {
      throw new BadRequestException("Le paiement en ligne passe par KKiaPay : rouvrez la commande pour payer.");
    }

    const canal = canalDe(req);
    let callbackUrl: string;
    if (canal === 'WEB' || order.channel === OrderChannel.WEB) {
      callbackUrl = callbackSite(order.id);
    } else {
      const retour = lienProfondAccepte(body?.retour);
      if (!retour) throw new BadRequestException('Lien de retour vers l’application invalide.');
      callbackUrl = callbackAppli(retour);
    }

    const deja = await this.prisma.tentativePaiement.count({ where: { order_id: order.id } });
    if (deja >= TENTATIVES_MAX_PAR_COMMANDE) {
      throw new BadRequestException(
        'Trop de tentatives de paiement pour cette commande. Contactez-nous pour la terminer.',
      );
    }

    return this.paystack.initialiser({
      order: {
        id: order.id,
        reference: order.reference,
        amount: order.amount,
        restaurant_id: order.restaurant_id,
        customer_id: order.customer_id,
      },
      email: order.email || order.customer?.email || null,
      canal: canal === 'WEB' || order.channel === OrderChannel.WEB ? 'WEB' : 'APP',
      callbackUrl,
    });
  }

  @Post('paystack/verifier')
  @UseGuards(JwtCustomerAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Vérifie un paiement Paystack au retour du client' })
  async verifier(@Req() req: Request, @Body() body: { reference?: string }) {
    const client = req.user as Customer;
    const reference = body?.reference;
    if (typeof reference !== 'string' || !REFERENCE_TENTATIVE.test(reference)) {
      throw new BadRequestException('Référence de paiement invalide.');
    }
    const tentative = await this.paystack.tentative(reference);
    if (!tentative || tentative.order.customer_id !== client.id) throw new NotFoundException('Paiement introuvable.');

    let issue;
    try {
      issue = await this.listener.confirmerPaiementPaystack(reference);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException('Le paiement est en cours de vérification. Réessayez dans un instant.');
      }
      throw e;
    }
    const commande = await this.prisma.order.findUnique({
      where: { id: tentative.order_id },
      select: { id: true, reference: true, status: true, paied: true },
    });
    if (!commande) throw new ForbiddenException();
    const relue = await this.paystack.tentative(reference);
    return {
      statut: commande.paied ? 'PAYEE' : relue?.statut === 'ECHEC' ? 'ECHEC' : 'EN_ATTENTE',
      confirme: !!issue?.confirmed || commande.paied,
      commande,
    };
  }
}
