import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { UnauthorizedException } from '@nestjs/common';

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
    const { sub, type } = payload;

    if (type === 'USER') {
      const user = await this.prisma.user.findUnique({
        where: { id: sub },
      });
      if (!user) {
        throw new UnauthorizedException('Utilisateur non trouvé');
      }
      const { password, ...rest } = user;
      return rest;
    }

    if (type === 'CUSTOMER') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: sub },
      });
      if (!customer) {
        throw new UnauthorizedException('Utilisateur non trouvé');
      }
      const { ...rest } = customer;
      return rest;
    }

    throw new UnauthorizedException('Type d\'utilisateur non reconnu');
  }
}
