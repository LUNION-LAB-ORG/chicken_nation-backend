import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdhesionService } from './adhesion.service';
import { CreateAdhesionDto } from './dto/create-adhesion.dto';

/**
 * Tunnel d'adhésion (Phase 4) — endpoint PUBLIC consommé par le site vitrine.
 *
 * PAS de garde JWT (le visiteur n'est pas authentifié), MAIS rate-limité par
 * ThrottlerGuard pour empêcher l'abus (spam d'inscriptions / d'envois WhatsApp).
 */
@ApiTags('Adhésion (Tunnel)')
@Controller('adhesion')
@UseGuards(ThrottlerGuard)
export class AdhesionController {
  constructor(private readonly adhesionService: AdhesionService) {}

  @Post()
  @HttpCode(200)
  // Rate limit dédié : 5 adhésions / minute / IP (au-dessus du défaut global).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: "Pré-inscription publique au programme (nom + téléphone + profil)",
  })
  register(@Body() dto: CreateAdhesionDto) {
    return this.adhesionService.register(dto);
  }
}
