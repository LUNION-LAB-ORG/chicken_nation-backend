import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RewardService } from '../services/reward.service';

class RepointerCadeauDto {
  @IsUUID()
  dish_id: string;
}

class RevoquerCadeauDto {
  @IsOptional()
  @IsString()
  motif?: string;
}

/**
 * Cadeaux déjà distribués — côté GESTION.
 *
 * `RewardController` est entièrement derrière le jeton CLIENT : il n'existait
 * donc aucun moyen, pour le personnel, de toucher un cadeau une fois émis.
 * C'est ce qui rendait le refus « faites pointer ce cadeau sur un autre plat »
 * impossible à suivre : repointer le lot ou la campagne ne change rien aux
 * cadeaux déjà entre les mains des clients, leur contenu étant figé au tirage.
 *
 * Contrôleur séparé, et non une route de plus dans `RewardController`, parce
 * qu'une exception de garde au milieu d'un contrôleur client est exactement le
 * genre de détail qu'on ne voit plus en relisant.
 */
@ApiTags('Fidelity')
@ApiBearerAuth()
@Controller('fidelity/rewards')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class RewardAdminController {
  constructor(private readonly rewardService: RewardService) {}

  @Patch(':id/plat')
  @ApiOperation({ summary: 'Faire pointer un cadeau distribué sur un autre plat' })
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  repointer(@Param('id') id: string, @Body() dto: RepointerCadeauDto) {
    return this.rewardService.repointerCadeauVersPlat(id, dto.dish_id);
  }

  @Patch(':id/revoquer')
  @ApiOperation({ summary: "Annuler un cadeau distribué (dernier recours)" })
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  revoquer(@Param('id') id: string, @Body() dto: RevoquerCadeauDto) {
    return this.rewardService.revoquerCadeau(id, dto.motif);
  }
}
