import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';

@Injectable()
export class JsonWebTokenService {
  private readonly secret: string;
  private readonly refreshSecret: string;
  private readonly customerSecret: string;
  private readonly delivererSecret: string;
  private readonly delivererRefreshSecret: string;
  private readonly delivererVerifySecret: string;
  private readonly delivererResetSecret: string;

  private readonly tokenExpiration: StringValue;
  private readonly refreshExpiration: StringValue;
  private readonly customerExpiration: StringValue;
  private readonly delivererExpiration: StringValue;
  private readonly delivererRefreshExpiration: StringValue;
  private readonly delivererVerifyExpiration: StringValue;
  private readonly delivererResetExpiration: StringValue;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.secret = this.configService.get<string>('TOKEN_SECRET', '');
    this.refreshSecret = this.configService.get<string>('REFRESH_TOKEN_SECRET', '');
    this.customerSecret = this.configService.get<string>('CUSTOMER_TOKEN_SECRET', '');
    this.delivererSecret = this.configService.get<string>('DELIVERER_TOKEN_SECRET', '');
    this.delivererRefreshSecret = this.configService.get<string>('DELIVERER_REFRESH_TOKEN_SECRET', '');
    this.delivererVerifySecret = this.configService.get<string>('DELIVERER_VERIFY_TOKEN_SECRET', '');
    this.delivererResetSecret = this.configService.get<string>('DELIVERER_RESET_TOKEN_SECRET', '');

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

    this.delivererExpiration = this.configService.get<StringValue>(
      'DELIVERER_TOKEN_EXPIRATION',
      '90d',
    );

    this.delivererRefreshExpiration = this.configService.get<StringValue>(
      'DELIVERER_REFRESH_TOKEN_EXPIRATION',
      '180d',
    );

    // Tokens courts utilisés pendant les flows d'inscription et reset
    this.delivererVerifyExpiration = this.configService.get<StringValue>(
      'DELIVERER_VERIFY_TOKEN_EXPIRATION',
      '15m',
    );

    this.delivererResetExpiration = this.configService.get<StringValue>(
      'DELIVERER_RESET_TOKEN_EXPIRATION',
      '15m',
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

  // DELIVERER ACCESS TOKEN (90j)
  async generateDelivererToken(delivererId: string) {
    return this.jwtService.signAsync(
      { sub: delivererId, type: 'deliverer' },
      {
        secret: this.delivererSecret,
        expiresIn: this.delivererExpiration,
      },
    );
  }

  // DELIVERER REFRESH TOKEN (180j)
  async generateDelivererRefreshToken(delivererId: string) {
    return this.jwtService.signAsync(
      { sub: delivererId, type: 'deliverer' },
      {
        secret: this.delivererRefreshSecret,
        expiresIn: this.delivererRefreshExpiration,
      },
    );
  }

  // DELIVERER VERIFY TOKEN (court, étape 2 de l'inscription)
  async generateDelivererVerifyToken(phone: string) {
    return this.jwtService.signAsync(
      { phone, scope: 'verify' },
      {
        secret: this.delivererVerifySecret,
        expiresIn: this.delivererVerifyExpiration,
      },
    );
  }

  async verifyDelivererVerifyToken(token: string): Promise<{ phone: string; scope: string }> {
    try {
      return await this.jwtService.verifyAsync(token, {
        secret: this.delivererVerifySecret,
      });
    } catch {
      throw new UnauthorizedException('Token de vérification invalide ou expiré');
    }
  }

  // DELIVERER RESET TOKEN (court, étape 2 du reset password)
  async generateDelivererResetToken(phone: string) {
    return this.jwtService.signAsync(
      { phone, scope: 'reset' },
      {
        secret: this.delivererResetSecret,
        expiresIn: this.delivererResetExpiration,
      },
    );
  }

  async verifyDelivererResetToken(token: string): Promise<{ phone: string; scope: string }> {
    try {
      return await this.jwtService.verifyAsync(token, {
        secret: this.delivererResetSecret,
      });
    } catch {
      throw new UnauthorizedException('Token de réinitialisation invalide ou expiré');
    }
  }

  async verifyToken(token: string, type: 'user' | 'customer' | 'deliverer') {
    try {
      const secretMap: Record<typeof type, string> = {
        user: this.secret,
        customer: this.customerSecret,
        deliverer: this.delivererSecret,
      };
      return await this.jwtService.verifyAsync(token, {
        secret: secretMap[type],
      });
    } catch {
      throw new UnauthorizedException('Token invalide');
    }
  }
}
