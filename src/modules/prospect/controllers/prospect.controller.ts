import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { ProspectService } from '../services/prospect.service';
import { CreateProspectDto } from '../dto/create-prospect.dto';
import { QueryProspectDto } from '../dto/query-prospect.dto';

@ApiTags('Prospects (Base de Données)')
@ApiBearerAuth()
@Controller('prospects')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ProspectController {
  constructor(private readonly prospectService: ProspectService) {}

  @Post()
  @RequirePermission(Modules.BASE_DONNEES, Action.CREATE)
  @ApiOperation({ summary: 'Saisir un nouveau contact Glovo/Yango (store)' })
  create(@Req() req: Request, @Body() dto: CreateProspectDto) {
    return this.prospectService.create(req.user as User, dto);
  }

  @Get('check-phone')
  @RequirePermission(Modules.BASE_DONNEES, Action.CREATE)
  @ApiOperation({ summary: 'Vérifier un doublon de téléphone avant saisie' })
  checkPhone(@Req() req: Request, @Query('phone') phone: string) {
    return this.prospectService.checkPhone(req.user as User, phone);
  }

  @Get()
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: 'Liste des contacts (admin), filtrable' })
  findAll(@Req() req: Request, @Query() query: QueryProspectDto) {
    return this.prospectService.findAll(req.user as User, query);
  }
}
