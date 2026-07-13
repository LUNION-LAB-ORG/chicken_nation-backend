import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Customer } from '@prisma/client';
import { RewardService } from '../services/reward.service';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';

/**
 * Récompenses « à gratter » du client connecté.
 * Cloisonnement STRICT côté serveur : le customer_id vient TOUJOURS du JWT,
 * jamais d'un paramètre client (cf. règle scoping du projet).
 */
@ApiTags('Rewards')
@Controller('fidelity/rewards')
export class RewardController {
    constructor(private readonly rewardService: RewardService) { }

    @Get('pending')
    @UseGuards(JwtCustomerAuthGuard)
    @ApiOperation({ summary: 'Récompenses à gratter du client connecté' })
    @ApiOkResponse({ description: 'Liste des récompenses en attente' })
    getPending(@Req() req: Request) {
        const customerId = (req.user as Customer).id;
        return this.rewardService.getPendingRewards(customerId);
    }

    @Get('redeemable-gifts')
    @UseGuards(JwtCustomerAuthGuard)
    @ApiOperation({ summary: 'Cadeaux (GIFT) du client, grattés et utilisables au panier (0 fr)' })
    @ApiOkResponse({ description: 'Cadeaux à ajouter au panier' })
    getRedeemableGifts(@Req() req: Request) {
        const customerId = (req.user as Customer).id;
        return this.rewardService.getRedeemableGifts(customerId);
    }

    @Post(':id/scratch')
    @UseGuards(JwtCustomerAuthGuard)
    @ApiOperation({ summary: 'Marquer une récompense comme grattée (idempotent)' })
    @ApiOkResponse({ description: 'Statut du grattage' })
    scratch(@Req() req: Request, @Param('id') id: string) {
        const customerId = (req.user as Customer).id;
        return this.rewardService.scratchReward(customerId, id);
    }
}
