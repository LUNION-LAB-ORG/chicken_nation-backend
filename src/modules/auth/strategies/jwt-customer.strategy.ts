import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { UnauthorizedException } from '@nestjs/common';

@Injectable()
export class JwtCustomerStrategy extends PassportStrategy(Strategy, 'jwt-customer') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('CUSTOMER_TOKEN_SECRET') ?? '',
    });
  }
  async validate(payload: any) {
    const { sub } = payload;

    const customer = await this.prisma.customer.findUnique({
      where: { id: sub },
    });
    if (!customer) {
      throw new UnauthorizedException('Utilisateur non trouvé');
    }
    const { ...rest } = customer;
    return rest;
  }
}
