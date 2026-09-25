import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { UnauthorizedException } from '@nestjs/common';
import { motifRefusCompte } from '../helpers/staff-account-status.helper';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('TOKEN_SECRET') ?? '',
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
    // Compte suspendu ou supprimé : le jeton ne vaut plus rien, quelle que soit
    // la garde (JwtAuthGuard, notifications, maps, garde optionnelle des menus).
    // Une erreur levée ici interrompt la chaîne passeport : une garde à
    // plusieurs stratégies ne tente pas la suivante.
    const motif = motifRefusCompte(user.entity_status);
    if (motif) {
      throw new UnauthorizedException(motif);
    }
    const { password, ...rest } = user;
    return rest;

  }
}
