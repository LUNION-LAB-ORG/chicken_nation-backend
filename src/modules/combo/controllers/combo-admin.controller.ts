import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { ComboAdminService } from '../services/combo-admin.service';
import { ComboService } from '../services/combo.service';
import { CreateComboGameDto } from '../dto/create-combo-game.dto';
import { UpdateComboGameDto } from '../dto/update-combo-game.dto';

/**
 * COMBO MYSTÈRE — back office (staff). CRUD des parties + suivi participations /
 * gagnants + déclenchement manuel du règlement. Réservé au module Fidélité
 * (mêmes gardes que Gratte & Gagne / campagnes Reward).
 */
@ApiTags('Combo Mystère (admin)')
@Controller('fidelity/combo')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ComboAdminController {
  constructor(
    private readonly comboAdminService: ComboAdminService,
    private readonly comboService: ComboService,
  ) {}

  @Get()
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Lister les parties Combo Mystère' })
  list() {
    return this.comboAdminService.list();
  }

  @Get(':id')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: "Détail d'une partie" })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.comboAdminService.get(id);
  }

  @Get(':id/participations')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Participations (tentatives) + gagnants d\'une partie' })
  participations(@Param('id', ParseUUIDPipe) id: string) {
    return this.comboAdminService.participations(id);
  }

  @Post()
  @RequirePermission(Modules.FIDELITE, Action.CREATE)
  @ApiOperation({ summary: 'Créer / planifier une partie (solution + lot depuis le menu réel)' })
  create(@Req() req: Request, @Body() dto: CreateComboGameDto) {
    return this.comboAdminService.create(dto, (req.user as User).id);
  }

  @Patch(':id')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Mettre à jour une partie (tant que non réglée)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateComboGameDto) {
    return this.comboAdminService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission(Modules.FIDELITE, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer (ou clôturer si déjà jouée) une partie' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.comboAdminService.remove(id);
  }

  @Post(':id/settle')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Déclencher manuellement le règlement (tirage) d\'une partie clôturée' })
  settle(@Param('id', ParseUUIDPipe) id: string) {
    return this.comboService.settleGame(id);
  }
}
