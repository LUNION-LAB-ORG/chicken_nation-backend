import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import type { Request } from 'express';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { IgnorerRelanceDto } from '../dto/ignorer-relance.dto';
import { QueryRelanceDto } from '../dto/query-relance.dto';
import { ROLES_BROUILLONS } from '../helpers/brouillons.rules';
import { OrderRelanceService } from '../services/order-relance.service';

/** Identifiant de commande illisible : même réponse qu'une commande inconnue. */
const ID_COMMANDE = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException('Commande introuvable.'),
});

/**
 * RELANCE DES COMMANDES EN ATTENTE (paniers de l'application non payés).
 *
 * Déclaré AVANT `OrderController` dans `OrderModule` : sinon `GET orders/:id`
 * capterait `orders/relances`.
 *
 * Volontairement SANS `UserScopedCacheInterceptor` : sa clé ignore le rôle, un
 * comptable recevrait la réponse mise en cache pour un administrateur.
 *
 * Rôles ADMIN et CALL_CENTER sur CHAQUE méthode (`ROLES_BROUILLONS`) : une
 * permission ne suffit pas, COMMANDES en lecture est aussi au comptable. Le
 * service revérifie le rôle (`UserRolesGuard` laisse passer un compte sans
 * rôle). Les gestes sont en POST : le journal d'audit global les trace déjà.
 */
@ApiTags('Commandes')
@Controller('orders/relances')
export class OrderRelanceController {
  constructor(private readonly relances: OrderRelanceService) {}

  @Get()
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiOperation({ summary: 'Paniers de l’application à relancer, pris, en cours de paiement' })
  lister(@Req() req: Request, @Query() query: QueryRelanceDto) {
    return this.relances.lister(req.user as User, query.restaurantId);
  }

  @Get('ignorees')
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiOperation({ summary: 'Paniers ignorés depuis 24 h' })
  listerIgnorees(@Req() req: Request, @Query() query: QueryRelanceDto) {
    return this.relances.listerIgnorees(req.user as User, query.restaurantId);
  }

  @Post(':orderId/prendre')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiOperation({ summary: '« Je m’en occupe » sur tout le groupe du client' })
  prendre(@Req() req: Request, @Param('orderId', ID_COMMANDE) orderId: string) {
    return this.relances.prendre(orderId, req.user as User);
  }

  @Post(':orderId/liberer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiOperation({ summary: 'Libérer la prise' })
  liberer(@Req() req: Request, @Param('orderId', ID_COMMANDE) orderId: string) {
    return this.relances.liberer(orderId, req.user as User);
  }

  @Post(':orderId/ignorer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiBody({ type: IgnorerRelanceDto })
  @ApiOperation({ summary: 'Ignorer pour toute l’équipe' })
  ignorer(
    @Req() req: Request,
    @Param('orderId', ID_COMMANDE) orderId: string,
    @Body() corps: IgnorerRelanceDto,
  ) {
    return this.relances.ignorer(orderId, corps, req.user as User);
  }

  @Post(':orderId/retablir')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiOperation({ summary: 'Rétablir dans les relances' })
  retablir(@Req() req: Request, @Param('orderId', ID_COMMANDE) orderId: string) {
    return this.relances.retablir(orderId, req.user as User);
  }
}
