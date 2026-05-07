import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from 'src/database/services/prisma.service';

/**
 * Valide les access tokens livreur (durée 90j).
 * Charge le Deliverer et vérifie qu'il n'est pas supprimé.
 */
@Injectable()
export class JwtDelivererStrategy extends PassportStrategy(Strategy, 'jwt-deliverer') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('DELIVERER_TOKEN_SECRET') ?? '',
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

    const { password, refresh_token, ...rest } = deliverer;
    return rest;
  }
}
