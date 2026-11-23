import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import type { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { OrderHabitudesService } from '../services/order-habitudes.service';

/**
 * Habitudes d'un client à la prise de commande du personnel.
 *
 * Droit : COMMANDES CREATE, celui qui permet de créer la commande (ADMIN,
 * CALL_CENTER, CAISSIER), comme pour les réductions.
 *
 * ⚠️ Déclaré AVANT OrderController dans le module : `orders/habitudes/...` ne
 * doit jamais être pris pour un identifiant de commande.
 */
@ApiTags('Commandes')
@Controller('orders/habitudes')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class OrderHabitudesController {
  constructor(private readonly habitudes: OrderHabitudesService) {}

  @Get('client/:customerId')
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @ApiOperation({
    summary: "Plats habituels et dernière commande d'un client",
    description:
      'Sur ses 30 dernières commandes qui comptent, hors annulées. Un plat est habituel à partir de deux commandes. ' +
      "Seuls les plats encore au menu pour ce client sont proposés. N'écrit rien.",
  })
  duClient(
    @Req() req: Request,
    @Param(
      'customerId',
      new ParseUUIDPipe({ exceptionFactory: () => new BadRequestException('Identifiant de client invalide.') }),
    )
    customerId: string,
  ) {
    return this.habitudes.duClient(req.user as User, customerId);
  }
}
