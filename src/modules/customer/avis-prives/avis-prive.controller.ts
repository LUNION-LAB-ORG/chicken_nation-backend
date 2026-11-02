import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { RestaurantQueryScopeGuard } from 'src/common/guards/restaurant-query-scope.guard';
import { ROLES_TRAITEMENT_AVIS } from 'src/modules/auth/constantes/roles-avis-prives';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { AvisPriveDepotService } from './avis-prive-depot.service';
import { AvisPriveThrottlerGuard } from './avis-prive-throttler.guard';
import { AvisPriveTraitementService } from './avis-prive-traitement.service';
import {
  AgentAvisDto,
  CommandeAvisDto,
  CompteursAvisQueryDto,
  CreerAvisPriveDto,
  JournalAvisDto,
  ListeAvisQueryDto,
  StatutAvisDto,
  TicketAvisDto,
} from './avis-prive.dto';
import { LIMITE_IP } from './avis-prive.rules';
import { AvisPriveService } from './avis-prive.service';

const utilisateur = (req: Request) => req.user as User;

/**
 * Retours PRIVÉS « Ton avis compte » (page /fr/avis du site, 02/11).
 *
 * Une route publique (l'envoi, par le serveur du site) et les routes du
 * module « Notes et avis » du back-office : lecture par `COMMENTAIRES READ`
 * (cloisonnée au restaurant pour un point de vente), traitement par la liste
 * de rôles `ROLES_TRAITEMENT_AVIS`, export par `COMMENTAIRES EXPORT`,
 * suppression par `COMMENTAIRES DELETE`.
 *
 * ⚠️ Contrôleur séparé de `comments` : `comments/:id` capterait ces chemins.
 * ⚠️ Ordre des routes : `compteurs`, `export` et `agents` AVANT `:id`.
 * ⚠️ Aucun cache : une fiche traitée doit se relire telle quelle.
 * Les numéros sortent sous les clés `telephone` : l'intercepteur global les
 * masque pour le marketing.
 */
@ApiTags('Avis privés')
@Controller('avis-prives')
export class AvisPriveController {
  constructor(
    private readonly depot: AvisPriveDepotService,
    private readonly avis: AvisPriveService,
    private readonly traitement: AvisPriveTraitementService,
  ) {}

  // ─── Route PUBLIQUE ─────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Envoi d'un avis depuis le site (public, sans jeton)" })
  @UseGuards(AvisPriveThrottlerGuard)
  @Throttle({ default: LIMITE_IP })
  @Post()
  async envoyer(@Body() dto: CreerAvisPriveDto) {
    return this.depot.deposer(dto);
  }

  // ─── Lecture (avant `:id`) ──────────────────────────────────────────────────

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Compteurs du haut de la liste' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @Get('compteurs')
  async compteurs(@Query() q: CompteursAvisQueryDto) {
    return this.avis.compteurs(q.restaurantId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Export CSV des avis filtrés' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.EXPORT)
  @Get('export')
  async exporter(@Query() q: ListeAvisQueryDto, @Res() res: Response) {
    const { page: _page, limit: _limit, ...filtres } = q;
    const fichier = await this.avis.exporter(filtres);
    res.setHeader('Content-Type', fichier.type);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.nom}"`);
    res.send(fichier.contenu);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Agents qui traitent les avis' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @UserRoles(...ROLES_TRAITEMENT_AVIS)
  @Get('agents')
  async agents() {
    return this.avis.agents();
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Liste paginée, triée « Pas content » non traités d’abord' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @Get()
  async liste(@Query() q: ListeAvisQueryDto) {
    return this.avis.liste(q);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Fiche d'un avis" })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @Get(':id')
  async fiche(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.avis.fiche(id, utilisateur(req));
  }

  // ─── Traitement (administrateur et call center) ────────────────────────────

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ajouter au journal : appel, WhatsApp ou note interne' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @UserRoles(...ROLES_TRAITEMENT_AVIS)
  @Post(':id/journal')
  async journal(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JournalAvisDto) {
    return this.traitement.journal(id, dto, utilisateur(req));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Changer le statut (clôture comprise)' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @UserRoles(...ROLES_TRAITEMENT_AVIS)
  @Patch(':id/statut')
  async statut(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatutAvisDto) {
    return this.traitement.statut(id, dto, utilisateur(req));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cocher ou décocher la commande concernée' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @UserRoles(...ROLES_TRAITEMENT_AVIS)
  @Patch(':id/commande')
  async commande(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommandeAvisDto) {
    return this.traitement.commande(id, dto, utilisateur(req));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Confier l'avis à un agent, ou le retirer" })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @UserRoles(...ROLES_TRAITEMENT_AVIS)
  @Patch(':id/agent')
  async agent(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgentAvisDto) {
    return this.traitement.agent(id, dto, utilisateur(req));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer un incident : ticket du module Messages et tickets' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.READ)
  @UserRoles(...ROLES_TRAITEMENT_AVIS)
  @Post(':id/ticket')
  async ticket(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketAvisDto) {
    return this.traitement.ticket(id, dto, utilisateur(req));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un avis et effacer son contenu personnel' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMENTAIRES, Action.DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async supprimer(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.traitement.supprimer(id, utilisateur(req));
  }
}
