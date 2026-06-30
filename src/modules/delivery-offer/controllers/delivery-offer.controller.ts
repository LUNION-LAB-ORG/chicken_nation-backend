import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from '../../auth/guards/user-permissions.guard';
import { RequirePermission } from '../../auth/decorators/user-require-permission';
import { Modules } from '../../auth/enums/module-enum';
import { Action } from '../../auth/enums/action.enum';
import { DeliveryOfferService } from '../services/delivery-offer.service';
import { CreateDeliveryOfferDto } from '../dto/create-delivery-offer.dto';
import { UpdateDeliveryOfferDto } from '../dto/update-delivery-offer.dto';
import { QueryDeliveryOfferDto } from '../dto/query-delivery-offer.dto';

@ApiTags('Offres de livraison')
@ApiBearerAuth()
@Controller('delivery-offers')
export class DeliveryOfferController {
  constructor(private readonly service: DeliveryOfferService) {}

  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.CREATE)
  @ApiOperation({ summary: 'Créer une offre de livraison' })
  create(@Req() req: Request, @Body() dto: CreateDeliveryOfferDto) {
    return this.service.create(req, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Lister les offres de livraison' })
  findAll(@Query() query: QueryDeliveryOfferDto) {
    return this.service.findAll(query);
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Statistiques des offres de livraison' })
  getStats() {
    return this.service.getStats();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Détail d\'une offre de livraison' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.UPDATE)
  @ApiOperation({ summary: 'Modifier une offre de livraison' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeliveryOfferDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer une offre de livraison (soft delete)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  @Post(':id/toggle')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.UPDATE)
  @ApiOperation({ summary: 'Activer/désactiver une offre de livraison' })
  toggleActive(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.toggleActive(id);
  }
}
