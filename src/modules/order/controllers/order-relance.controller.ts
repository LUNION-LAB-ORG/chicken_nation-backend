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
import { OrderStatus, User } from '@prisma/client';
import type { Request } from 'express';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { AnnulerRelanceDto } from '../dto/annuler-relance.dto';
import { ConfirmerPaiementRelanceDto } from '../dto/confirmer-paiement-relance.dto';
import { IgnorerRelanceDto } from '../dto/ignorer-relance.dto';
import { QueryRelanceDto } from '../dto/query-relance.dto';
import { ROLES_BROUILLONS } from '../helpers/brouillons.rules';
import { A_CONFIRMER_WHERE } from '../helpers/paiement-livraison.rules';
import { KkiapayOrderListenerService } from '../listeners/kkiapay-order.listener.service';
import { OrderRelanceService } from '../services/order-relance.service';
import { OrderService } from '../services/order.service';

/** Identifiant de commande illisible : même réponse qu'une commande inconnue. */
const ID_COMMANDE = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException('Commande introuvable.'),
});

/**
 * RELANCE DES COMMANDES EN ATTENTE (paniers de l'application non payés, et
 * commandes du site à payer à la livraison, à confirmer, depuis le 19/10).
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
  constructor(
    private readonly relances: OrderRelanceService,
    // Annulation d'une commande à confirmer : le chemin ordinaire des
    // annulations (coupon et cadeaux rendus, client prévenu). Aucun cycle :
    // c'est OrderService qui dépend de la relance, pas ce contrôleur.
    private readonly orders: OrderService,
    // Confirmation d'un paiement KKiaPay resté sans suite (14/11) : le chemin
    // du webhook, revérification KKiaPay comprise. Appelé d'ici et non du
    // service de relance, pour la même raison d'absence de cycle.
    private readonly kkiapay: KkiapayOrderListenerService,
  ) {}

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

  /**
   * Ignorer sort la commande des alertes de toute l'équipe, sans l'annuler :
   * elle reste en attente et se rétablit depuis « Ignorées » (décision du
   * 25/11, retour sur celle du 23/11 où ignorer l'annulait).
   */
  @Post(':orderId/ignorer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiBody({ type: IgnorerRelanceDto })
  @ApiOperation({ summary: 'Ignorer pour toute l’équipe (la commande reste en attente)' })
  ignorer(
    @Req() req: Request,
    @Param('orderId', ID_COMMANDE) orderId: string,
    @Body() corps: IgnorerRelanceDto,
  ) {
    return this.relances.ignorer(orderId, corps, req.user as User);
  }

  /**
   * « Annuler la commande » : seulement une commande du site à payer à la
   * livraison, encore à confirmer (19/10). Elle ne s'ignore pas : le client
   * attendrait l'appel pour toujours.
   *
   * L'écriture est CONDITIONNÉE à l'état « à confirmer » : si un collègue la
   * reprend au téléphone pendant ce temps, sa reprise l'emporte et
   * l'annulation répond 409, au lieu d'annuler une commande tout juste
   * transmise au restaurant.
   */
  @Post(':orderId/annuler')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiBody({ type: AnnulerRelanceDto })
  @ApiOperation({ summary: 'Annuler une commande du site à payer à la livraison' })
  async annuler(
    @Req() req: Request,
    @Param('orderId', ID_COMMANDE) orderId: string,
    @Body() corps: AnnulerRelanceDto,
  ): Promise<{ ok: true }> {
    const user = req.user as User;
    const raison = await this.relances.verifierAnnulable(orderId, corps, user);
    await this.orders.updateStatus(
      orderId,
      OrderStatus.CANCELLED,
      { userId: user.id, role: user.role, reason: raison },
      { conditionEcriture: A_CONFIRMER_WHERE },
    );
    await this.relances.noterAnnulation(orderId, user.id, raison);
    return { ok: true };
  }

  /**
   * « Confirmer le paiement » (14/11) : le client a payé en ligne, le webhook
   * n'a pas confirmé la commande, elle attend dans « À relancer ».
   *
   * L'identifiant de transaction n'est jamais cru sur parole : la
   * confirmation rejoue le chemin du webhook, qui interroge KKiaPay et ne
   * confirme QUE si le paiement a réussi et couvre la commande. Une
   * transaction qui paie déjà une autre commande est refusée (409). Aucun
   * « forcer ». C'est ce qui permet d'ouvrir le geste au centre d'appels,
   * quand la route `POST /orders/:id/confirm-payment` reste aux administrateurs.
   *
   * Confirmée, la commande part au restaurant (cloche, notification au client,
   * points), comme après un webhook ; l'agent et la transaction restent au
   * journal de la relance et au journal d'audit.
   */
  @Post(':orderId/confirmer-paiement')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(...ROLES_BROUILLONS)
  @ApiBody({ type: ConfirmerPaiementRelanceDto })
  @ApiOperation({ summary: 'Confirmer le paiement KKiaPay d’un panier resté en attente' })
  async confirmerPaiement(
    @Req() req: Request,
    @Param('orderId', ID_COMMANDE) orderId: string,
    @Body() corps: ConfirmerPaiementRelanceDto,
  ): Promise<{ ok: true; reference: string; deja_confirmee: boolean; en_double: boolean }> {
    const user = req.user as User;
    const { transactionId, commande } = await this.relances.verifierPaiementConfirmable(orderId, corps, user);
    const resultat = await this.kkiapay.confirmPaymentManually(orderId, transactionId);
    await this.relances.noterPaiementConfirme(commande, user, transactionId, {
      justPaid: resultat.justPaid,
      enDouble: resultat.enDouble,
    });
    return {
      ok: true,
      reference: commande.reference,
      deja_confirmee: !resultat.justPaid,
      en_double: resultat.enDouble,
    };
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
