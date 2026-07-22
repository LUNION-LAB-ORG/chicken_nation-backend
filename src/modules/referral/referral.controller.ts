import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Customer } from '@prisma/client';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { ReferralService } from './referral.service';
import { ApplyReferralDto } from './dto/apply-referral.dto';

/**
 * Parrainage côté client connecté. Cloisonnement STRICT : le customer_id vient
 * TOUJOURS du JWT (jamais d'un paramètre client).
 */
@ApiTags('Referral')
@Controller('referral')
@UseGuards(JwtCustomerAuthGuard)
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('code')
  @ApiOperation({ summary: 'Code de parrainage du client (généré si absent)' })
  @ApiOkResponse({ description: 'Le code de parrainage partageable' })
  async getCode(@Req() req: Request) {
    const customerId = (req.user as Customer).id;
    const referral_code = await this.referralService.getOrCreateReferralCode(customerId);
    return { referral_code };
  }

  @Get('me')
  @ApiOperation({ summary: 'Suivi du parrainage du client (code + compteurs)' })
  @ApiOkResponse({ description: 'Code + total/en attente/récompensés' })
  getStats(@Req() req: Request) {
    const customerId = (req.user as Customer).id;
    return this.referralService.getReferralStats(customerId);
  }

  @Get('wallet')
  @ApiOperation({ summary: 'Wallet ambassadeur : filleuls (masqués), ventes, gains, soldes' })
  @ApiOkResponse({ description: 'Tableau de bord monétaire du parrain (Phase 5)' })
  getWallet(@Req() req: Request) {
    const customerId = (req.user as Customer).id;
    return this.referralService.getAmbassadorDashboard(customerId);
  }

  @Get('ambassador/dashboard')
  @ApiOperation({ summary: "Tableau de bord ambassadeur (contrat de l'app mobile)" })
  @ApiOkResponse({ description: 'Code, réglages, agrégats, filleuls masqués, versements' })
  getAmbassadorDashboard(@Req() req: Request) {
    const customerId = (req.user as Customer).id;
    return this.referralService.getAmbassadorDashboardForApp(customerId);
  }

  @Post('apply')
  @ApiOperation({ summary: 'Appliquer un code de parrainage (filleul, à l’inscription)' })
  @ApiOkResponse({ description: 'Parrainage créé + bon de bienvenue crédité' })
  apply(@Req() req: Request, @Body() dto: ApplyReferralDto) {
    const customerId = (req.user as Customer).id;
    return this.referralService.applyReferralCode(customerId, dto.code);
  }
}
