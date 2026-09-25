import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, UseInterceptors, Query } from '@nestjs/common';
import { FavoriteService } from 'src/modules/customer/services/favorite.service';
import { CreateFavoriteDto } from 'src/modules/customer/dto/create-favorite.dto';
import { UpdateFavoriteDto } from 'src/modules/customer/dto/update-favorite.dto';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Customer, UserRole } from '@prisma/client';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UserScopedCacheInterceptor } from 'src/modules/order/interceptors/user-scoped-cache.interceptor';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';

/**
 * ⚠️ Cache cloisonné par utilisateur, et non le `CacheInterceptor` par URL.
 * La clé était l'URL seule alors que la réponse est celle du porteur du jeton :
 * un client qui appelait /favorites/customer/<id d'un autre> dans la seconde
 * recevait les favoris de cet autre client, ou lui servait les siens.
 */
@ApiTags('Favorites')
@ApiBearerAuth()
@Controller('favorites')
@UseInterceptors(UserScopedCacheInterceptor)
export class FavoriteController {
  constructor(private readonly favoriteService: FavoriteService) { }

  @ApiOperation({ summary: 'Création d\'une nouvelle favorite' })
  @UseGuards(JwtCustomerAuthGuard)
  @Post()
  create(@Req() req: Request, @Body() createFavoriteDto: CreateFavoriteDto) {
    return this.favoriteService.create(req, createFavoriteDto);
  }

  // ⚠️ Administrateur seulement : tous les favoris de tous les clients, fiche
  // client complète comprise, sans pagination ni restaurant. Ouverte à CLIENTS
  // READ, elle valait un export pour un rôle en consultation (Marketing) et
  // livrait tout le réseau au personnel d'un restaurant. Aucun écran ne
  // l'appelle (l'application passe par /favorites/customer/:id).
  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, UserRolesGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @UserRoles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Récupération de toutes les favorites' })
  findAll() {
    return this.favoriteService.findAll();
  }

  @ApiOperation({ summary: 'Obtenir une favorite par ID' })
  // ⚠️ Route sans aucune garde, vérifiée joignable en production sans jeton.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.favoriteService.findOne(id);
  }

  @ApiOperation({ summary: 'Obtenir toutes les favorites d un client' })
  // ⚠️ Garde CLIENT et non personnelle : c'est l'application qui appelle cette
  // route, avec son propre jeton. Voir le contrôleur des adresses pour le
  // détail. Le paramètre d'URL est ignoré au profit du jeton.
  @UseGuards(JwtCustomerAuthGuard)
  @Get('customer/:customerId')
  findByCustomer(
    @Req() req: Request,
    @Param('customerId') customerId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.favoriteService.findByCustomer((req.user as Customer).id, page, limit);
  }

  @ApiOperation({ summary: 'Mettre à jour une favorite' })
  // ⚠️ Le propriétaire n'était pas vérifié : tout client connecté modifiait le
  // favori d'un autre dont il connaissait l'identifiant. Aucun appelant.
  @UseGuards(JwtCustomerAuthGuard)
  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() updateFavoriteDto: UpdateFavoriteDto) {
    return this.favoriteService.update((req.user as Customer).id, id, updateFavoriteDto);
  }

  @ApiOperation({ summary: 'Supprimer une favorite' })
  // ⚠️ Même défaut que la modification : seul le propriétaire supprime.
  @UseGuards(JwtCustomerAuthGuard)
  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.favoriteService.remove((req.user as Customer).id, id);
  }

  @ApiOperation({ summary: 'Supprimer une favorite par client et plat' })
  @UseGuards(JwtCustomerAuthGuard)
  @Delete('customer/:customerId/dish/:dishId')
  // ⚠️ L'identifiant client venait de l'URL : tout client vidait les favoris
  // d'un autre. Le paramètre est conservé pour ne pas casser l'application,
  // mais IGNORE : seul le jeton fait foi.
  removeByCustomerAndDish(
    @Req() req: Request,
    @Param('customerId') customerId: string,
    @Param('dishId') dishId: string,
  ) {
    return this.favoriteService.removeByCustomerAndDish(
      (req.user as Customer).id,
      dishId,
    );
  }
}