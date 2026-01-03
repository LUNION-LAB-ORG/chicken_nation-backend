import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';

@Injectable()
export class JsonWebTokenService {
  private readonly secret: string;
  private readonly refreshSecret: string;
  private readonly customerSecret: string;

  private readonly tokenExpiration: StringValue;
  private readonly refreshExpiration: StringValue;
  private readonly customerExpiration: StringValue;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.secret = this.configService.get<string>('TOKEN_SECRET', '');
    this.refreshSecret = this.configService.get<string>('REFRESH_TOKEN_SECRET', '');
    this.customerSecret = this.configService.get<string>('CUSTOMER_TOKEN_SECRET', '');

    this.tokenExpiration = this.configService.get<StringValue>(
      'TOKEN_EXPIRATION',
      '1h',
    );

    this.refreshExpiration = this.configService.get<StringValue>(
      'REFRESH_TOKEN_EXPIRATION',
      '7d',
    );

    this.customerExpiration = this.configService.get<StringValue>(
      'CUSTOMER_TOKEN_EXPIRATION',
      '30d',
    );
  }

  // USER TOKEN
  async generateToken(userId: string) {
    return this.jwtService.signAsync(
      { sub: userId },
      {
        secret: this.secret,
        expiresIn: this.tokenExpiration,
      },
    );
  }

  // REFRESH TOKEN
  async generateRefreshToken(userId: string) {
    return this.jwtService.signAsync(
      { sub: userId },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshExpiration,
      },
    );
  }

  // CUSTOMER TOKEN
  async generateCustomerToken(userId: string) {
    return this.jwtService.signAsync(
      { sub: userId },
      {
        secret: this.customerSecret,
        expiresIn: this.customerExpiration,
      },
    );
  }

  async verifyToken(token: string, type: 'user' | 'customer') {
    try {
      return await this.jwtService.verifyAsync(token, {
        secret: type === 'user' ? this.secret : this.customerSecret,
      });
    } catch {
      throw new UnauthorizedException('Token invalide');
    }
  }
}
