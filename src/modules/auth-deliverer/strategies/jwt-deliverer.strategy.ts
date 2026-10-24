import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import type { DelivererSignalPayload } from 'src/modules/deliverers/events/deliverer.event';

import {
  ENTETE_PROTOCOLE_APPLI,
  lireProtocoleAppli,
  majSignalLivreur,
} from '../helpers/signal-livreur.rules';

/**
 * Valide les access tokens livreur (durée 90j).
 * Charge le Deliverer et vérifie qu'il n'est pas supprimé.
 *
 * Relève au passage le signe de vie du livreur et le protocole de son appli
 * (signal-livreur.rules.ts), sans attendre l'écriture ni la laisser échouer
 * la requête. Chaque signe de vie écrit part aussi au minuteur « en ligne »
 * (`DELIVERER_SIGNAL`), avec l'état du livreur avant la requête.
 */
@Injectable()
export class JwtDelivererStrategy extends PassportStrategy(Strategy, 'jwt-deliverer') {
  private readonly logger = new Logger(JwtDelivererStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('DELIVERER_TOKEN_SECRET') ?? '',
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: { sub: string; type: string }) {
    if (payload.type !== 'deliverer') {
      throw new UnauthorizedException('Token invalide');
    }

    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: payload.sub },
    });
    if (!deliverer) {
      throw new UnauthorizedException('Livreur non trouvé');
    }

    const maj = majSignalLivreur(
      deliverer,
      lireProtocoleAppli(req.headers?.[ENTETE_PROTOCOLE_APPLI]),
      new Date(),
    );
    if (maj) {
      void this.prisma.deliverer
        .update({ where: { id: deliverer.id }, data: maj, select: { id: true } })
        .catch((err) =>
          this.logger.warn(`Signe de vie du livreur ${deliverer.id.slice(0, 8)} non écrit : ${err?.message}`),
        );
      this.events.emit(DelivererChannels.DELIVERER_SIGNAL, {
        delivererId: deliverer.id,
        a: maj.dernier_signal_at.toISOString(),
        etat: {
          pause_until: deliverer.pause_until,
          auto_pause_until: deliverer.auto_pause_until,
          last_available_at: deliverer.last_available_at,
        },
      } satisfies DelivererSignalPayload);
    }

    const { password, refresh_token, ...rest } = deliverer;
    return rest;
  }
}
