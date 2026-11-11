import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User, UserRole } from '@prisma/client';
import type { Request, Response } from 'express';
import {
  ROLES_LECTURE_INCIDENT,
  ROLES_SIEGE_INCIDENT,
  ROLES_SIGNALEMENT_INCIDENT,
  ROLES_TRAITEMENT_INCIDENT,
} from 'src/modules/auth/constantes/roles-incidents';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { IncidentReglagesService } from './incident-reglages.service';
import { IncidentTraitementService } from './incident-traitement.service';
import {
  AssignerIncidentDto,
  CloturerIncidentDto,
  CreerCategorieIncidentDto,
  FiltresIncidentDto,
  ListeIncidentDto,
  ModifierCategorieIncidentDto,
  NoteIncidentDto,
  PorteeIncidentDto,
  RechercheCommandeDto,
  ReglagesIncidentDto,
  ResoudreIncidentDto,
  RouvrirIncidentDto,
  SignalerIncidentDto,
  StatistiquesIncidentDto,
} from './incident.dto';
import { IncidentService } from './incident.service';

const utilisateur = (req: Request) => req.user as User;

/**
 * INCIDENTS SUR COMMANDE (11/11) : le dossier de traitement d'un problème
 * sur une commande, pont entre le CRM, les tickets et les avis.
 *
 * Gardé par listes de rôles (`roles-incidents.ts`) ; le cloisonnement au
 * restaurant d'un point de vente et les droits au cas par cas (traiter,
 * offrir un bon) sont tranchés dans les services, sur l'incident chargé.
 *
 * ⚠️ Ordre des routes : tous les chemins fixes AVANT `:id`.
 * ⚠️ Aucun cache : une fiche traitée doit se relire telle quelle.
 * Les numéros sortent sous la clé `telephone` : l'intercepteur global les
 * masque pour le marketing.
 */
@ApiTags('Incidents')
@ApiBearerAuth()
@Controller('incidents')
@UseGuards(JwtAuthGuard, UserRolesGuard)
export class IncidentController {
  constructor(
    private readonly incidents: IncidentService,
    private readonly traitement: IncidentTraitementService,
    private readonly reglagesService: IncidentReglagesService,
  ) {}

  // ─── Réglages ───────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Catégories et barème des bons' })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get('reglages')
  async reglages() {
    return this.incidents.reglagesEtCategories();
  }

  @ApiOperation({ summary: 'Changer le barème, la validité des bons, le droit des restaurants' })
  @UserRoles(UserRole.ADMIN)
  @Put('reglages')
  async enregistrerReglages(@Body() dto: ReglagesIncidentDto) {
    return this.reglagesService.enregistrer(dto);
  }

  @ApiOperation({ summary: 'Ajouter une catégorie' })
  @UserRoles(UserRole.ADMIN)
  @Post('categories')
  async creerCategorie(@Body() dto: CreerCategorieIncidentDto) {
    return this.reglagesService.creerCategorie(dto);
  }

  @ApiOperation({ summary: 'Renommer, régler ou désactiver une catégorie' })
  @UserRoles(UserRole.ADMIN)
  @Patch('categories/:id')
  async modifierCategorie(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ModifierCategorieIncidentDto) {
    return this.reglagesService.modifierCategorie(id, dto);
  }

  // ─── Lectures (avant `:id`) ─────────────────────────────────────────────────

  @ApiOperation({ summary: "Compteurs : pastille de l'onglet et bandeau" })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get('compteurs')
  async compteurs(@Req() req: Request, @Query() q: PorteeIncidentDto) {
    return this.incidents.compteurs(utilisateur(req), q.restaurantId);
  }

  @ApiOperation({ summary: 'Tableau : Ouvert, En cours, Résolu, Clôturé' })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get('tableau')
  async tableau(@Req() req: Request, @Query() q: FiltresIncidentDto) {
    return this.incidents.tableau(q, utilisateur(req));
  }

  @ApiOperation({ summary: 'Tableau de bord : catégories, restaurants, délais, bons' })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get('statistiques')
  async statistiques(@Req() req: Request, @Query() q: StatistiquesIncidentDto) {
    return this.incidents.statistiques(q, utilisateur(req));
  }

  @ApiOperation({ summary: 'Export CSV des incidents filtrés' })
  @UserRoles(...ROLES_SIEGE_INCIDENT)
  @Get('export')
  async exporter(@Req() req: Request, @Query() q: ListeIncidentDto, @Res() res: Response) {
    const { page: _page, limit: _limit, ...filtres } = q;
    const fichier = await this.incidents.exporter(filtres, utilisateur(req));
    res.setHeader('Content-Type', fichier.type);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.nom}"`);
    res.send(fichier.contenu);
  }

  @ApiOperation({ summary: 'Agents du siège à qui confier un incident' })
  @UserRoles(...ROLES_SIEGE_INCIDENT)
  @Get('agents')
  async agents() {
    return this.incidents.agents();
  }

  @ApiOperation({ summary: 'Chercher la commande à signaler (référence, nom, téléphone)' })
  @UserRoles(...ROLES_SIGNALEMENT_INCIDENT)
  @Get('commandes')
  async commandes(@Req() req: Request, @Query() q: RechercheCommandeDto) {
    return this.incidents.chercherCommandes(q.recherche, utilisateur(req));
  }

  @ApiOperation({ summary: "Incidents d'une commande" })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get('commande/:orderId')
  async parCommande(@Req() req: Request, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.incidents.parCommande(orderId, utilisateur(req));
  }

  @ApiOperation({ summary: 'Incidents non clôturés, par commande (étiquettes des listes)' })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get('ouverts')
  async ouverts(@Req() req: Request, @Query() q: PorteeIncidentDto) {
    return this.incidents.ouverts(utilisateur(req), q.restaurantId);
  }

  @ApiOperation({ summary: 'Historique paginé' })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get()
  async liste(@Req() req: Request, @Query() q: ListeIncidentDto) {
    return this.incidents.liste(q, utilisateur(req));
  }

  // ─── Signaler ───────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Signaler un incident sur une commande' })
  @UserRoles(...ROLES_SIGNALEMENT_INCIDENT)
  @Post()
  async signaler(@Req() req: Request, @Body() dto: SignalerIncidentDto) {
    return this.traitement.signaler(dto, utilisateur(req));
  }

  // ─── Fiche et gestes ────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Fiche d'un incident" })
  @UserRoles(...ROLES_LECTURE_INCIDENT)
  @Get(':id')
  async fiche(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.incidents.fiche(id, utilisateur(req));
  }

  @ApiOperation({ summary: 'Prendre en charge, ou confier à un responsable ou à un agent' })
  @UserRoles(...ROLES_TRAITEMENT_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/assigner')
  async assigner(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignerIncidentDto) {
    return this.traitement.assigner(id, dto, utilisateur(req));
  }

  @ApiOperation({ summary: 'Résoudre : cause, action corrective, geste' })
  @UserRoles(...ROLES_TRAITEMENT_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/resoudre')
  async resoudre(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResoudreIncidentDto) {
    return this.traitement.resoudre(id, dto, utilisateur(req));
  }

  @ApiOperation({ summary: 'Clôturer après le recontact du client' })
  @UserRoles(...ROLES_TRAITEMENT_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/cloturer')
  async cloturer(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloturerIncidentDto) {
    return this.traitement.cloturer(id, dto, utilisateur(req));
  }

  @ApiOperation({ summary: 'Rouvrir un incident résolu ou clôturé' })
  @UserRoles(...ROLES_SIEGE_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/rouvrir')
  async rouvrir(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RouvrirIncidentDto) {
    return this.traitement.rouvrir(id, dto, utilisateur(req));
  }

  @ApiOperation({ summary: 'Ajouter une note au journal' })
  @UserRoles(...ROLES_SIGNALEMENT_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/notes')
  async noter(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteIncidentDto) {
    return this.traitement.noter(id, dto, utilisateur(req));
  }

  @ApiOperation({ summary: 'Créer le bon qui a échoué à la résolution' })
  @UserRoles(...ROLES_TRAITEMENT_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/bon')
  async creerBon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.traitement.creerBon(id, utilisateur(req));
  }

  @ApiOperation({ summary: 'Renvoyer le SMS du code du bon' })
  @UserRoles(...ROLES_TRAITEMENT_INCIDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/bon/sms')
  async renvoyerSms(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.traitement.renvoyerSms(id, utilisateur(req));
  }
}
