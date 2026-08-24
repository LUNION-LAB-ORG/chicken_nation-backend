import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { ReplaceDishOptionGroupsDto } from '../dto/dish-option-group.dto';
import { DishOptionService } from '../services/dish-option.service';

/**
 * MENUS COMPOSABLES — configuration réservée au personnel.
 *
 * Toutes les routes sont derrière l'authentification et la permission MENUS :
 * ce qui se décide ici fixe le prix payé par le client, cela ne se laisse pas
 * en accès libre. Aucune application n'appelle ces routes.
 */
@Controller('dishes/:dishId/option-groups')
@ApiTags('Dishes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class DishOptionController {
  constructor(private readonly dishOptionService: DishOptionService) { }

  @Get()
  @ApiOperation({ summary: "Configuration composable d'un plat" })
  @RequirePermission(Modules.MENUS, Action.READ)
  findByDish(@Param('dishId') dishId: string) {
    return this.dishOptionService.findByDish(dishId);
  }

  @Put()
  @ApiOperation({ summary: "Enregistrer la configuration composable d'un plat" })
  @RequirePermission(Modules.MENUS, Action.UPDATE)
  replace(
    @Param('dishId') dishId: string,
    @Body() dto: ReplaceDishOptionGroupsDto,
  ) {
    return this.dishOptionService.replaceForDish(dishId, dto.groups);
  }

  @Get('usages-cadeau')
  @ApiOperation({
    summary: "Ce qui empêche ce plat de devenir composable (lots, campagnes, cadeaux déjà distribués)",
  })
  @RequirePermission(Modules.MENUS, Action.READ)
  usagesCadeau(@Param('dishId') dishId: string) {
    return this.dishOptionService.usagesCadeau(dishId);
  }

  @Post('copier-vers/:cibleId')
  @ApiOperation({ summary: "Copier cette configuration sur un autre plat" })
  @RequirePermission(Modules.MENUS, Action.UPDATE)
  copier(@Param('dishId') dishId: string, @Param('cibleId') cibleId: string) {
    return this.dishOptionService.copierVers(dishId, cibleId);
  }
}
