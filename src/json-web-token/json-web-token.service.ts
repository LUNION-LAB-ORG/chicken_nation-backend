import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JsonWebTokenService {
  private readonly secret: string;
  private readonly refreshSecret: string;
  private readonly tokenExpiration: string;
  private readonly refreshExpiration: string;
  private readonly customerSecret: string;
  private readonly customerExpiration: string;
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.secret = this.configService.get<string>('TOKEN_SECRET') ?? "";
    this.refreshSecret = this.configService.get<string>('REFRESH_TOKEN_SECRET') ?? "";
    this.tokenExpiration = this.configService.get<string>('TOKEN_EXPIRATION') ?? "";
    this.refreshExpiration = this.configService.get<string>('REFRESH_TOKEN_EXPIRATION') ?? "";
    this.customerSecret = this.configService.get<string>('CUSTOMER_TOKEN_SECRET') ?? "";
    this.customerExpiration = this.configService.get<string>('CUSTOMER_TOKEN_EXPIRATION') ?? "";

  }

  // GENERATE TOKEN
  async generateToken(userId: string) {
    const payload = { sub: userId };
    const token = await this.jwtService.signAsync(payload, {
      secret: this.secret,
      expiresIn: this.tokenExpiration,
    });

    return token;
  }

  // GENERATE REFRESH TOKEN
  async generateRefreshToken(userId: string) {
    const payload = { sub: userId };
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshExpiration,
    });

    return refreshToken;
  }


  // GENERATE CUSTOMER TOKEN
  async generateCustomerToken(userId: string) {
    const payload = { sub: userId };
    const token = await this.jwtService.signAsync(payload, {
      secret: this.customerSecret,
      expiresIn: this.customerExpiration,
    });

    return token;
  }

  async verifyToken(token: string, type: "user" | "customer") {
    try {
      const decoded = await this.jwtService.verifyAsync(token, {
        secret: type === "user" ? this.secret : this.customerSecret,
      });
      return decoded;
    } catch (error) {
      throw new UnauthorizedException('Token invalide');
    }
  }
}
