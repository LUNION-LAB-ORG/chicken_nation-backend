import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';
import { EntityStatus, User } from '@prisma/client';
import { LoginUserDto } from 'src/modules/auth/dto/login-user.dto';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { OtpService } from 'src/modules/auth/otp/otp.service';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { TwilioService } from 'src/twilio/services/twilio.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonWebTokenService: JsonWebTokenService,
    private readonly otpService: OtpService,
    private readonly twilioService: TwilioService,
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
    const token = await this.jsonWebTokenService.generateToken(user.id);
    const refreshToken = await this.jsonWebTokenService.generateRefreshToken(user.id);

    // Mise à jour du statut de l'utilisateur
    await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        entity_status: EntityStatus.ACTIVE,
        last_login_at: new Date(),
      },
    });
    // Renvoi de l'utilisateur, le token et le refreshToken
    return { ...rest, token, refreshToken };
  }

  // LOGIN CUSTOMER
  async loginCustomer(phone: string) {

    // Vérification de l'existence de l'utilisateur
    let customer = await this.prisma.customer.findUnique({
      where: {
        phone,
      },
    });

    // Si le client n'existe pas, on le crée
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          phone,
        },
      });
    }

    // génération de OTP
    const otp = await this.otpService.generate(customer.phone);

    // Envoyer l'OTP par SMS
    const isSent = await this.twilioService.sendOtp({ phoneNumber: customer.phone, otp });
    if (!isSent) {
      throw new Error('Envoi de l\'OTP impossible');
    }
    return { otp };
  }


  // VERIFY OTP
  async verifyOtp(data: VerifyOtpDto) {
    // Recuperation de l'otp dans la table otpToken
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: data.otp,
        phone: data.phone,
        expire: {
          gte: new Date(),
        },
      },
    });

    if (!otpToken) {
      throw new UnauthorizedException('Code OTP invalide');
    }

    // Vérification de l'otp
    const isVerified = await this.otpService.verify(otpToken.code);
    if (!isVerified) {
      throw new UnauthorizedException('Code OTP invalide');
    }

    // Récupération de l'utilisateur client

    const customer = await this.prisma.customer.findUnique({
      where: {
        phone: otpToken.phone,
      },
    });

    if (!customer) {
      throw new NotFoundException("Utilisateur non trouvé");
    }

    const { entity_status, ...rest } = customer;

    // Génération du token et du refreshToken
    const token = await this.jsonWebTokenService.generateCustomerToken(customer.id);

    // Mise à jour du statut de l'utilisateur
    await this.prisma.customer.update({
      where: {
        id: customer.id,
      },
      data: {
        entity_status: EntityStatus.ACTIVE,
        last_login_at: new Date(),
      },
    });
    // Renvoi de l'utilisateur, le token et le refreshToken
    return { ...rest, token };
  }

  // REFRESH TOKEN
  async refreshToken(req: Request) {
    const user = req.user as User;
    const token = await this.jsonWebTokenService.generateToken(user.id);

    return { token };
  }
}
