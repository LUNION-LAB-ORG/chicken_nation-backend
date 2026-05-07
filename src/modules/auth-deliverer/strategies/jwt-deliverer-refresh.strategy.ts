import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from 'src/database/services/prisma.service';

/**
 * Valide les refresh tokens livreur (durée 180j).
 * Le refresh token est également hashé en DB pour permettre la rotation / révocation.
 */
@Injectable()
export class JwtDelivererRefreshStrategy extends PassportStrategy(Strategy, 'jwt-deliverer-refresh') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('DELIVERER_REFRESH_TOKEN_SECRET') ?? '',
    });
  }

  async validate(payload: { sub: string; type: string }) {
    if (payload.type !== 'deliverer') {
      throw new UnauthorizedException('Token invalide');
    }

    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: payload.sub },
    });
    if (!deliverer) {
      throw new UnauthorizedException('Livreur non trouvé');
    }

    const { password, ...rest } = deliverer;
    return rest;
  }
}
