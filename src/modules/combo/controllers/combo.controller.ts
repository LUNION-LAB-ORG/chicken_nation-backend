import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Customer } from '@prisma/client';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { ComboService } from '../services/combo.service';
import { SubmitAttemptDto } from '../dto/submit-attempt.dto';

/**
 * COMBO MYSTÈRE — côté client (app). Cloisonnement STRICT : le customer_id vient
 * TOUJOURS du JWT, jamais d'un paramètre. La solution n'est JAMAIS exposée.
 */
@ApiTags('Combo Mystère')
@Controller('combo')
@UseGuards(JwtCustomerAuthGuard)
export class ComboController {
  constructor(private readonly comboService: ComboService) {}

  @Get('current')
  @ApiOperation({ summary: 'Jeu Combo ouvert + état du client (essais restants, déjà joué)' })
  @ApiOkResponse({ description: 'Jeu courant ou null' })
  getCurrent(@Req() req: Request) {
    return this.comboService.getCurrent((req.user as Customer).id);
  }

  @Post(':id/attempt')
  @ApiOperation({ summary: 'Soumettre une combinaison (essais bornés RG-10)' })
  @ApiOkResponse({ description: '{ correct, attempts_left }' })
  attempt(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitAttemptDto) {
    return this.comboService.submitAttempt((req.user as Customer).id, id, dto.answer);
  }

  @Get(':id/result')
  @ApiOperation({ summary: "Résultat d'une partie réglée : a-t-il gagné ?" })
  @ApiOkResponse({ description: '{ settled, won, reward_id }' })
  result(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.comboService.getResult((req.user as Customer).id, id);
  }
}
