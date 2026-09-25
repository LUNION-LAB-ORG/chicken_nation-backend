import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { UnauthorizedException } from '@nestjs/common';
import { motifRefusCompte } from '../helpers/staff-account-status.helper';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('REFRESH_TOKEN_SECRET') ?? '',
    });
  }
  async validate(payload: any) {
    const { sub } = payload;
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
    });
    if (!user) {
      throw new UnauthorizedException('Utilisateur non trouvé');
    }
    // Compte suspendu ou supprimé : aucun nouveau jeton d'accès. JwtRefreshAuthGuard
    // le contrôlait déjà ; la stratégie le garantit pour toute garde qui s'en sert.
    const motif = motifRefusCompte(user.entity_status);
    if (motif) {
      throw new UnauthorizedException(motif);
    }
    const { password, ...rest } = user;
    return rest;
  }
}
