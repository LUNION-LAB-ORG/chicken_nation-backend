import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';
import { User } from '@prisma/client';
import { LoginUserDto } from 'src/auth/dto/login-user.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) { }

  // LOGIN USER
  async login(loginUserDto: LoginUserDto) {
    // Vérification de l'existence de l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: {
        email: loginUserDto.email,
      },
    });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }
    const { password, ...rest } = user;

    // Vérification du mot de passe
    const isPasswordValid = await bcrypt.compare(
      loginUserDto.password,
      password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Mot de passe invalide');
    }

    // Génération du token et du refreshToken
    const token = await this.generateToken(user.id);
    const refreshToken = await this.generateRefreshToken(user.id);

    // Renvoi de l'utilisateur, le token et le refreshToken
    return { ...rest, token, refreshToken };
  }

  // REFRESH TOKEN
  async refreshToken(req: Request) {
    const user = req.user as User;
    const token = await this.generateToken(user.id);

    return { token };
  }

  // GENERATE TOKEN
  async generateToken(userId: string) {
    const payload = { sub: userId };
    const token = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('TOKEN_SECRET'),
      expiresIn: this.configService.get<string>('TOKEN_EXPIRATION'),
    });
    console.log(this.configService.get<string>('TOKEN_SECRET'), this.configService.get<string>('TOKEN_EXPIRATION'))
    return token;
  }

  // GENERATE REFRESH TOKEN
  async generateRefreshToken(userId: string) {
    const payload = { sub: userId };
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('REFRESH_TOKEN_SECRET'),
      expiresIn: this.configService.get<string>('REFRESH_TOKEN_EXPIRATION'),
    });

    return refreshToken;
  }
}
