import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { CallsService } from './services/calls.service';
import { CallsConfigService } from './services/calls-config.service';
import { LunionMeetService } from './services/lunion-meet.service';
import { StartCallDto } from './dto/start-call.dto';
import { UpdateCallsConfigDto } from './dto/update-calls-config.dto';
import { CallsRolesConfig } from './constants/calls.constants';

@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly callsConfig: CallsConfigService,
    private readonly lunion: LunionMeetService,
  ) {}

  // ─────────── Webhook Lunion (public, vérif HMAC) ───────────
  @Post('webhook')
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-lunion-event') event: string,
    @Body() body: { room?: string },
  ) {
    const signature =
      (req.headers['x-lunion-signature'] as string | undefined) ?? undefined;
    const ok = await this.lunion.verifyWebhook(
      req.rawBody ?? JSON.stringify(body),
      signature,
    );
    if (!ok) return { received: false };
    await this.calls.handleWebhook(event, body);
    return { received: true };
  }

  // ─────────── Routage configurable ───────────
  /** Config effective (tout utilisateur authentifié — l'UI en a besoin). */
  @Get('config')
  @UseGuards(JwtAuthGuard)
  getConfig() {
    return this.callsConfig.getConfig();
  }

  /** Écriture de la config — ADMIN seul (permission SETTINGS.UPDATE). */
  @Put('config')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  updateConfig(@Body() dto: UpdateCallsConfigDto) {
    return this.callsConfig.setConfig(dto as unknown as CallsRolesConfig);
  }

  // ─────────── Cycle de vie d'un appel ───────────
  @Get('history')
  @UseGuards(JwtAuthGuard)
  history(@Req() req: Request, @Query('limit') limit?: string) {
    return this.calls.history(req.user as User, limit ? Number(limit) : 30);
  }

  /** Appels qui sonnent encore pour moi (resynchro à la connexion). */
  @Get('ringing')
  @UseGuards(JwtAuthGuard)
  ringing(@Req() req: Request) {
    return this.calls.listRingingForMe(req.user as User);
  }

  /** Mon appel actif (restauré après un rechargement de page) — jeton frais. */
  @Get('active')
  @UseGuards(JwtAuthGuard)
  active(@Req() req: Request) {
    return this.calls.getActiveForMe(req.user as User);
  }

  /** Statut d'un appel (polling de convergence — filet des events socket). */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  getStatus(@Param('id') id: string, @Req() req: Request) {
    return this.calls.getStatus(id, req.user as User);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  start(@Req() req: Request, @Body() dto: StartCallDto) {
    return this.calls.start(req.user as User, dto);
  }

  @Post(':id/answer')
  @UseGuards(JwtAuthGuard)
  answer(@Param('id') id: string, @Req() req: Request) {
    return this.calls.answer(id, req.user as User);
  }

  @Post(':id/reject')
  @UseGuards(JwtAuthGuard)
  reject(@Param('id') id: string, @Req() req: Request) {
    return this.calls.reject(id, req.user as User);
  }

  @Post(':id/hangup')
  @UseGuards(JwtAuthGuard)
  hangup(@Param('id') id: string, @Req() req: Request) {
    return this.calls.hangup(id, req.user as User);
  }
}
