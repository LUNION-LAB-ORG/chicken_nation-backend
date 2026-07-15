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

  // ── Durcissement OTP (audit) : plafond de tentatives de VÉRIFICATION ──────
  // Au-delà de MAX_OTP_VERIFY_ATTEMPTS échecs dans une fenêtre glissante de
  // OTP_VERIFY_WINDOW_MS, le numéro est verrouillé pendant OTP_LOCKOUT_MS.
  // Empêche le brute-force d'un code à 4 chiffres (10 000 combinaisons).
  // Persisté en DB (OtpVerificationAttempt) → robuste au double backend.
  private static readonly MAX_OTP_VERIFY_ATTEMPTS = 5;
  private static readonly OTP_VERIFY_WINDOW_MS = 15 * 60 * 1000; // 15 min
  private static readonly OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 min

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
    // ── Durcissement : rejeter d'emblée si le numéro est verrouillé (trop
    // d'échecs récents) AVANT toute comparaison de code. ──────────────────
    await this.assertOtpNotLocked(data.phone);

    // Validation COMPLÈTE et suffisante : le token stocké correspond-il au
    // (téléphone + code) saisi, et n'est-il pas expiré ?
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: data.otp,
        phone: data.phone,
        expire: { gte: new Date() },
      },
    });

    if (!otpToken) {
      // Échec : on incrémente le compteur (fenêtre glissante) et on verrouille
      // le numéro si le plafond est atteint. Ne casse pas le flux normal.
      await this.registerFailedOtpAttempt(data.phone);
      throw new UnauthorizedException('Code OTP invalide');
    }

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

    // Succès : on remet à zéro le compteur d'échecs de vérification.
    await this.clearOtpAttempts(otpToken.phone);

    return { ...rest, token };
  }

  // ── Helpers durcissement OTP ───────────────────────────────────────────────

  /**
   * Bloque la vérification si le numéro est actuellement verrouillé (429).
   * Purge le verrou expiré au passage (dégradation naturelle).
   */
  private async assertOtpNotLocked(phone: string): Promise<void> {
    const attempt = await this.prisma.otpVerificationAttempt.findUnique({
      where: { phone },
    });
    if (!attempt?.locked_until) return;

    const remainingMs = attempt.locked_until.getTime() - Date.now();
    if (remainingMs > 0) {
      const minutes = Math.ceil(remainingMs / 60000);
      throw new HttpException(
        `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
        429,
      );
    }
    // Verrou expiré → repartir d'une fenêtre propre.
    await this.prisma.otpVerificationAttempt.update({
      where: { phone },
      data: { failed_count: 0, window_start: new Date(), locked_until: null },
    });
  }

  /**
   * Enregistre un échec de vérification (fenêtre glissante) et pose un verrou
   * temporaire dès que le plafond est atteint. Best-effort : une erreur DB ici
   * ne doit jamais empêcher de renvoyer « OTP invalide » (flux normal préservé).
   */
  private async registerFailedOtpAttempt(phone: string): Promise<void> {
    try {
      const now = new Date();
      const existing = await this.prisma.otpVerificationAttempt.findUnique({
        where: { phone },
      });

      if (!existing) {
        await this.prisma.otpVerificationAttempt.create({
          data: { phone, failed_count: 1, window_start: now },
        });
        return;
      }

      // Fenêtre expirée → on repart à 1.
      const windowExpired =
        now.getTime() - existing.window_start.getTime() >
        AuthService.OTP_VERIFY_WINDOW_MS;
      const nextCount = windowExpired ? 1 : existing.failed_count + 1;
      const reachedCap = nextCount >= AuthService.MAX_OTP_VERIFY_ATTEMPTS;

      await this.prisma.otpVerificationAttempt.update({
        where: { phone },
        data: {
          failed_count: nextCount,
          window_start: windowExpired ? now : existing.window_start,
          locked_until: reachedCap
            ? new Date(now.getTime() + AuthService.OTP_LOCKOUT_MS)
            : existing.locked_until,
        },
      });
    } catch (error) {
      this.logger.error(
        `Suivi des tentatives OTP échoué pour ${phone}: ${String(error)}`,
      );
    }
  }

  /** Remet à zéro le suivi des tentatives après une vérification réussie. */
  private async clearOtpAttempts(phone: string): Promise<void> {
    try {
      await this.prisma.otpVerificationAttempt.deleteMany({ where: { phone } });
    } catch {
      // best-effort : sans importance si la ligne n'existait pas.
    }
  }

  // REFRESH TOKEN
  async refreshToken(req: Request) {
    const user = req.user as User;
    const token = await this.jsonWebTokenService.generateToken(user.id);
    return { token };
  }
}
