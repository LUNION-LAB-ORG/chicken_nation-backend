import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { AddPaiementDto, CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { CreatePaiementKkiapayDto } from '../dto/create-paiement-kkiapay.dto';

import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

/** Garde-fou commun aux endpoints d'édition/suppression de paiement : seul un
 *  ADMIN peut corriger un paiement déjà enregistré (audit comptable, erreur de
 *  saisie). Pour les autres rôles, on lève 403. Sert aussi à la création brute
 *  (POST /paiements), qui est une correction du registre au même titre. */
function assertAdmin(
  req: Request,
  message = "Seul un administrateur peut modifier ou supprimer un paiement existant.",
) {
  const user = req.user as User | undefined;
  if (user?.role !== UserRole.ADMIN) {
    throw new ForbiddenException(message);
  }
}

@ApiTags('Paiements')
@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) { }

  // ⚠️ Aucune permission : tout jeton personnel, cuisine comprise, agissait sur l'argent.
  // ⚠️ COMMANDES UPDATE laissait encore passer la CUISINE, qui n'encaisse pas
  // (la caisse lui affichait le formulaire faute de contrôle de rôle).
  // UPDATE_FULL est détenu par tous les rôles qui encaissent : caissier,
  // gérant, assistant, centre d'appel, administrateur. Le restaurant de la
  // commande est contrôlé dans le service.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE_FULL)
  @Post('add')
  @ApiOperation({ summary: 'Payer via backoffice' })
  addPaiement(@Req() req: Request, @Body() data: AddPaiementDto) {
    return this.paiementsService.addPaiement(req, data);
  }

  @Post('pay')
  // Guard AJOUTÉ (audit 31/07) : la route lisait `req.user as Customer` sans
  // aucune authentification — client_id indéfini pour un appel anonyme.
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Payer avec Kkiapay' })
  payWithKkiapay(@Req() req: Request, @Body() createPaiementKkiapayDto: CreatePaiementKkiapayDto) {
    return this.paiementsService.payWithKkiapay(req, createPaiementKkiapayDto);
  }

  // ⚠️ Aucune permission : tout jeton personnel, cuisine comprise, agissait sur l'argent.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.DELETE)
  @Post('refund/:id')
  @ApiOperation({ summary: 'Remboursement d\'un paiement par Kkiapay' })
  refundPaiement(@Param('id') paiementId: string) {
    return this.paiementsService.refundPaiement(paiementId);
  }

  // ⚠️ Aucune permission : tout jeton personnel, cuisine comprise, agissait sur l'argent.
  // ⚠️ Même droit que l'ajout d'un paiement (UPDATE_FULL) : la cuisine ne
  // confirme pas d'encaissement. Restaurant de la commande contrôlé dans le service.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE_FULL)
  @Patch(':id/confirmer-encaissement')
  @ApiOperation({
    summary: "Confirmer un encaissement livreur en attente",
    description:
      "Un livreur (Turbo) a encaissé le client à la livraison : le paiement est PENDING. " +
      "La confirmation le passe en SUCCESS, marque la commande payée et la termine si elle est livrée.",
  })
  confirmerEncaissement(@Req() req: Request, @Param('id') paiementId: string) {
    return this.paiementsService.confirmerEncaissement(req, paiementId);
  }

  // ⚠️ Sans garde alors que la méthode lit `req.user` : l'appel anonyme
  // partait en 500. Toutes les routes voisines sont gardées.
  @UseGuards(JwtCustomerAuthGuard)
  @Get('free')
  @ApiOperation({ summary: 'Obtenir les paiements libres' })
  getFreePaiements(@Req() req: Request) {
    return this.paiementsService.getFreePaiements(req);
  }

  // Guard AJOUTÉ (revue 31/07) : la route ANONYME permettait de FABRIQUER un
  // Paiement SUCCESS arbitraire, contournant le contrôle « montant couvert »
  // (fraude au paiement-jeton) et polluant la traçabilité multi-comptes.
  // ⚠️ Aucune permission : tout membre du personnel fabriquait un paiement
  // SUCCESS arbitraire, rattaché à la commande de n'importe quel restaurant.
  // ⚠️ Audit des droits (25/09) : COMMANDES CREATE l'ouvrait encore à la caisse
  // et au centre d'appel, avec référence (un vrai transactionId KKiaPay), compte
  // encaisseur et statut libres. Ce paiement compte dans le cumul « montant
  // couvert » des paiements suivants. Aucun écran ne l'appelle ; l'encaissement
  // normal passe par POST /paiements/add. Administrateur seul, comme PATCH et
  // DELETE : c'est une correction du registre.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @Post()
  @ApiOperation({ summary: 'Créer un paiement brut (admin uniquement)' })
  create(@Req() req: Request, @Body() createPaiementDto: CreatePaiementDto) {
    assertAdmin(
      req,
      "Seul un administrateur peut créer un paiement directement. Pour encaisser une commande, ajoutez un paiement depuis la commande.",
    );
    return this.paiementsService.create(createPaiementDto);
  }

  // Guard AJOUTÉ (revue 31/07) : la liste ANONYME fuyait références, montants
  // et coordonnées clients de tous les paiements.
  // ⚠️ Le seul JWT ouvrait encore la liste à tout le personnel, cuisine comprise,
  // tous restaurants confondus : références KKiaPay et coordonnées des clients.
  // Registre comptable : administrateur et comptable. Aucun écran ne l'appelle.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.REPORT)
  @Get()
  @ApiOperation({ summary: 'Lister tous les paiements' })
  findAll(@Query() queryDto: QueryPaiementDto) {
    return this.paiementsService.findAll(queryDto);
  }

  // ⚠️ Même exposition que la liste, paiement par paiement : même garde.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.REPORT)
  @Get(':id')
  @ApiOperation({ summary: 'Obtenir un paiement par son ID' })
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Modifier un paiement (admin uniquement). Recalcule order.paied." })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdatePaiementDto,
  ) {
    assertAdmin(req);
    return this.paiementsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Supprimer un paiement (admin uniquement). Recalcule order.paied.' })
  remove(@Req() req: Request, @Param('id') id: string) {
    assertAdmin(req);
    return this.paiementsService.remove(id);
  }
}
