import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, HttpException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { EntityStatus, User } from '@prisma/client';
import { LoginUserDto } from 'src/modules/auth/dto/login-user.dto';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { OtpService } from 'src/modules/auth/otp/otp.service';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
    const { password: _, ...rest } = user;
    return {
      ...rest,
      token,
      refreshToken,
      role: user.role,
      permissions: rolePermissions,
    };
  }

  // Délai minimum entre deux envois d'OTP pour un même numéro (anti-flood).
  // Protège les coûts Twilio + la contention DB quand des milliers de clients
  // spamment « renvoyer le code » (ou contournent le timer UI en revenant à
  // l'écran téléphone / en relançant l'app). Aligné sur le timer de 30s de
  // l'écran OTP mobile pour ne pas pénaliser le flux légitime.
  private static readonly OTP_RESEND_COOLDOWN_MS = 30 * 1000;

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

    // Anti-flood : si un code a été envoyé il y a moins de COOLDOWN, on refuse
    // d'en générer/envoyer un nouveau (le précédent reste valide 5 min).
    const wait = await this.otpService.getResendCooldownSeconds(
      customer.phone,
      AuthService.OTP_RESEND_COOLDOWN_MS,
    );
    if (wait > 0) {
      throw new HttpException(
        `Un code vient d'être envoyé. Réessayez dans ${wait} seconde${wait > 1 ? 's' : ''}.`,
        429,
      );
    }

    const otp = await this.otpService.generate(customer.phone);

    const isSent = await this.twilioService.sendOtp({ phoneNumber: customer.phone, otp });
    if (!isSent) {
      // this.logger.error(`Échec de l'envoi de l'OTP au numéro ${customer.phone}`);
      throw new HttpException('Envoi de l\'OTP impossible', 500);
    }
    return { otp };
  }

  // VERIFY OTP
  async verifyOtp(data: VerifyOtpDto) {
    // Validation COMPLÈTE et suffisante : le token stocké correspond-il au
    // (téléphone + code) saisi, et n'est-il pas expiré ?
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: data.otp,
        phone: data.phone,
        expire: { gte: new Date() },
      },
    });

    if (!otpToken) throw new UnauthorizedException('Code OTP invalide');

    // ⚠️ NE PAS re-vérifier via otpService.verify() : ce HOTP recompare au
    // COMPTEUR GLOBAL COURANT (partagé par tous les utilisateurs et incrémenté
    // à chaque génération). Dès qu'un autre OTP est généré entre l'envoi et la
    // saisie (autre client, re-demande, 2e backend sur la même base), le
    // compteur a bougé → la recomparaison échoue et renvoie « OTP invalide »
    // alors que le code stocké est correct. Le lookup ci-dessus suffit.

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

    // Consommer les OTP de ce numéro (usage unique) : empêche la réutilisation
    // du même code et purge les anciens codes encore valides pour ce téléphone.
    await this.prisma.otpToken.deleteMany({ where: { phone: otpToken.phone } });

    return { ...rest, token };
  }

  // REFRESH TOKEN
  async refreshToken(req: Request) {
    const user = req.user as User;
    const token = await this.jsonWebTokenService.generateToken(user.id);
    return { token };
  }
}
