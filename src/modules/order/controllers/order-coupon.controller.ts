import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';
import type { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { ApercuCouponDto } from '../dto/apercu-coupon.dto';
import { CouponThrottlerGuard, LIMITE_COUPON } from '../guards/coupon-throttler.guard';
import { OrderCouponService } from '../services/order-coupon.service';

/**
 * Réduction à la prise de commande du personnel : code promo (coupons CRM
 * compris) ou bon d'achat du client.
 *
 * Droit : COMMANDES CREATE, celui qui permet de créer la commande (ADMIN,
 * CALL_CENTER, CAISSIER ; décision du 25/09). Le caissier n'a ni PROMOTIONS ni
 * FIDELITE : les routes de ces modules ne conviennent pas.
 *
 * Gardes dans cet ordre : jeton, droit, puis limite de débit PAR AGENT (qui a
 * besoin de `req.user`).
 *
 * ⚠️ Déclaré AVANT OrderController dans le module : `orders/coupon/...` ne doit
 * jamais être pris pour un identifiant de commande.
 */
@ApiTags('Commandes')
@Controller('orders/coupon')
@UseGuards(JwtAuthGuard, UserPermissionsGuard, CouponThrottlerGuard)
export class OrderCouponController {
  constructor(private readonly orderCoupon: OrderCouponService) {}

  @Post('apercu')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @Throttle(LIMITE_COUPON)
  @ApiOperation({
    summary: "Aperçu d'un code promo ou d'un bon sur une commande à créer",
    description:
      "Recalcule le panier côté serveur avec les fonctions de la création, puis la remise. N'écrit rien. " +
      'Refus en 400/403/404 avec un message en français prêt à afficher.',
  })
  apercu(@Req() req: Request, @Body() dto: ApercuCouponDto) {
    return this.orderCoupon.apercu(req.user as User, dto);
  }

  @Get('bons-client/:customerId')
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @Throttle(LIMITE_COUPON)
  @ApiOperation({
    summary: 'Bons actifs du client, code masqué',
    description: "20 au plus, échéance la plus proche d'abord. Le client dicte le code complet.",
  })
  bonsClient(
    @Req() req: Request,
    @Param(
      'customerId',
      new ParseUUIDPipe({ exceptionFactory: () => new BadRequestException('Identifiant de client invalide.') }),
    )
    customerId: string,
  ) {
    return this.orderCoupon.listerBonsClient(req.user as User, customerId);
  }
}
