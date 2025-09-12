import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { EntityStatus, User } from '@prisma/client';
import { LoginUserDto } from 'src/modules/auth/dto/login-user.dto';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { OtpService } from 'src/modules/auth/otp/otp.service';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { permissionsByRole } from 'src/common/constantes/permissionsByRole';
import { UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonWebTokenService: JsonWebTokenService,
    private readonly otpService: OtpService,
    private readonly twilioService: TwilioService,
  ) {}

  // LOGIN USER
  async login(loginUserDto: LoginUserDto) {
    // Vérification de l'existence de l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: { email: loginUserDto.email },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    // Vérification du mot de passe
    const isPasswordValid = await bcrypt.compare(loginUserDto.password, user.password);
    if (!isPasswordValid) throw new BadRequestException('Mot de passe invalide');

    // Génération du token et du refreshToken
    const token = await this.jsonWebTokenService.generateToken(user.id);
    const refreshToken = await this.jsonWebTokenService.generateRefreshToken(user.id);

    // Mise à jour du statut de l'utilisateur
    await this.prisma.user.update({
      where: { id: user.id },
      data: { entity_status: EntityStatus.ACTIVE, last_login_at: new Date() },
    });

    // Récupération des permissions selon le rôle
    const rolePermissions = permissionsByRole[user.role as UserRole];

    // Renvoi des informations
    const { password: _, ...rest } = user; // Exclure le mot de passe
    return {
      ...rest,
      token,
      refreshToken,
      role: user.role,
      permissions: rolePermissions,
    };
  }

  // LOGIN CUSTOMER
  async loginCustomer(phone: string) {
    let customer = await this.prisma.customer.findFirst({
      where: {
        phone,
        entity_status: { not: EntityStatus.DELETED },
      },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({ data: { phone } });
    }

    const otp = await this.otpService.generate(customer.phone);

    const isSent = await this.twilioService.sendOtp({ phoneNumber: customer.phone, otp });
    if (!isSent) throw new Error("Envoi de l'OTP impossible");

    return { otp };
  }

  // VERIFY OTP
  async verifyOtp(data: VerifyOtpDto) {
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: data.otp,
        phone: data.phone,
        expire: { gte: new Date() },
      },
    });

    if (!otpToken) throw new UnauthorizedException('Code OTP invalide');

    const isVerified = await this.otpService.verify(otpToken.code);
    if (!isVerified) throw new UnauthorizedException('Code OTP invalide');

    const customer = await this.prisma.customer.findFirst({
      where: { phone: otpToken.phone, entity_status: { not: EntityStatus.DELETED } },
    });

    if (!customer) throw new NotFoundException('Utilisateur non trouvé');

    const { entity_status, ...rest } = customer;
    const token = await this.jsonWebTokenService.generateCustomerToken(customer.id);

    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { entity_status: EntityStatus.ACTIVE, last_login_at: new Date() },
    });

    return { ...rest, token };
  }

  // REFRESH TOKEN
  async refreshToken(req: Request) {
    const user = req.user as User;
    const token = await this.jsonWebTokenService.generateToken(user.id);
    return { token };
  }
}
