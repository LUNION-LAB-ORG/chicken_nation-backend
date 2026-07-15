import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { LoyaltyLevel, User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { ScratchLotService } from '../services/scratch-lot.service';
import { ScratchEngineService } from '../services/scratch-engine.service';
import { CreateScratchLotDto } from '../dto/create-scratch-lot.dto';
import { UpdateScratchLotDto } from '../dto/update-scratch-lot.dto';

/**
 * Gratte & Gagne — back office (staff). CRUD des lots + outils moteur
 * (simulateur de probabilités/surcoût, moniteur d'enveloppe). Réservé au module
 * Fidélité (mêmes gardes que les autres routes admin).
 */
@ApiTags('Scratch (Gratte & Gagne)')
@Controller('fidelity/scratch')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ScratchLotController {
    constructor(
        private readonly scratchLotService: ScratchLotService,
        private readonly scratchEngine: ScratchEngineService,
    ) { }

    // ── Outils moteur (avant :id pour éviter la collision de route) ──

    @Get('simulate')
    @RequirePermission(Modules.FIDELITE, Action.READ)
    @ApiOperation({ summary: "Simuler la distribution des probabilités et l'espérance de surcoût pour un panier" })
    @ApiQuery({ name: 'amount', required: true, description: 'Montant du panier (order.amount)' })
    @ApiQuery({ name: 'level', required: false, enum: LoyaltyLevel, description: 'Niveau de fidélité du client (optionnel)' })
    simulate(@Query('amount') amount: string, @Query('level') level?: LoyaltyLevel) {
        return this.scratchEngine.simulate(Number(amount) || 0, level ?? null);
    }

    @Get('envelope')
    @RequirePermission(Modules.FIDELITE, Action.READ)
    @ApiOperation({ summary: "Moniteur d'enveloppe : surcoût moyen réalisé sur la fenêtre vs cible" })
    envelope() {
        return this.scratchEngine.envelopeMonitor();
    }

    // ── CRUD lots ──

    @Get('lots')
    @RequirePermission(Modules.FIDELITE, Action.READ)
    @ApiOperation({ summary: 'Lister les lots Gratte & Gagne' })
    list() {
        return this.scratchLotService.list();
    }

    @Get('lots/:id')
    @RequirePermission(Modules.FIDELITE, Action.READ)
    @ApiOperation({ summary: "Détail d'un lot" })
    get(@Param('id') id: string) {
        return this.scratchLotService.get(id);
    }

    @Post('lots')
    @RequirePermission(Modules.FIDELITE, Action.CREATE)
    @ApiOperation({ summary: 'Créer un lot Gratte & Gagne' })
    create(@Req() req: Request, @Body() dto: CreateScratchLotDto) {
        return this.scratchLotService.create(dto, (req.user as User).id);
    }

    @Patch('lots/:id')
    @RequirePermission(Modules.FIDELITE, Action.UPDATE)
    @ApiOperation({ summary: 'Mettre à jour un lot' })
    update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateScratchLotDto) {
        return this.scratchLotService.update(id, dto, (req.user as User).id);
    }

    @Delete('lots/:id')
    @RequirePermission(Modules.FIDELITE, Action.DELETE)
    @ApiOperation({ summary: 'Supprimer (ou désactiver si déjà tiré) un lot' })
    remove(@Param('id') id: string) {
        return this.scratchLotService.remove(id);
    }
}
