import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Deliverer, DelivererStatus, EntityStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { OtpService } from 'src/modules/auth/otp/otp.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { TwilioService } from 'src/twilio/services/twilio.service';

import { CompleteRegistrationDto } from '../dto/complete-registration.dto';
import { DeleteAccountDto } from '../dto/delete-account.dto';
import { LoginDelivererDto } from '../dto/login-deliverer.dto';
import { RegisterPhoneDto } from '../dto/register-phone.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { VerifyDelivererOtpDto } from '../dto/verify-otp.dto';

/**
 * Service d'authentification pour les livreurs.
 *
 * Flows :
 *  - Inscription  : register-phone (OTP) → verify-otp (verifyToken) → complete-registration (Deliverer créé, status = PENDING_VALIDATION)
 *  - Connexion    : login (phone + password) → { access, refresh }
 *  - Reset        : forgot-password (OTP) → verify-reset-otp (resetToken) → reset-password
 *  - Refresh      : refresh-token → nouveau access token
 *  - Session      : me (profil + is_operational), logout (invalide le refresh_token hash)
 */
@Injectable()
export class AuthDelivererService {
  private readonly logger = new Logger(AuthDelivererService.name);
  private static readonly BCRYPT_ROUNDS = 12;
  /** Période de grâce avant suppression définitive (RGPD + récupération possible) */
  static readonly DELETION_GRACE_DAYS = 90;

  /**
   * Génère une référence métier unique : `LIV-YYMMDD-XXXXX`.
   * Pattern identique à generateOrderReference (cohérence projet).
   */
  private generateDelivererReference(): string {
    const d = new Date();
    const yy = d.getFullYear().toString().slice(-2);
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const dd = d.getDate().toString().padStart(2, '0');
    const rand = Math.floor(10000 + Math.random() * 90000);
    return `LIV-${yy}${mm}${dd}-${rand}`;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JsonWebTokenService,
    private readonly otpService: OtpService,
    private readonly twilioService: TwilioService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ============================================================
  // INSCRIPTION
  // ============================================================

  /**
   * Étape 1 : génère et envoie un OTP au numéro fourni.
   * Refuse si un livreur existe déjà avec ce numéro (sauf si entity_status = DELETED).
   */
  async registerPhone(dto: RegisterPhoneDto) {
    const existing = await this.prisma.deliverer.findFirst({
      where: {
        phone: dto.phone,
        entity_status: { not: EntityStatus.DELETED },
      },
    });

    if (existing) {
      throw new ConflictException('Un livreur avec ce numéro existe déjà');
    }

    const otp = await this.otpService.generate(dto.phone);
    const isSent = await this.twilioService.sendOtp({ phoneNumber: dto.phone, otp });

    if (!isSent) {
      throw new HttpException("Envoi de l'OTP impossible", 500);
    }

    return { phone: dto.phone, message: 'Code OTP envoyé' };
  }

  /**
   * Étape 2 : vérifie l'OTP et retourne un verifyToken (court, 15min)
   * qui sera utilisé à l'étape 3 pour créer le Deliverer.
   */
  async verifyRegistrationOtp(dto: VerifyDelivererOtpDto) {
    await this.assertOtpValid(dto.phone, dto.otp);
    const verifyToken = await this.jwt.generateDelivererVerifyToken(dto.phone);
    return { verifyToken };
  }

  /**
   * Étape 3 : finalise l'inscription avec profil, documents et mot de passe.
   * Le Deliverer est créé avec status = PENDING_VALIDATION et is_operational = false.
   * L'admin devra ensuite valider et affecter à un restaurant.
   */
  async completeRegistration(dto: CompleteRegistrationDto) {
    const payload = await this.jwt.verifyDelivererVerifyToken(dto.verifyToken);
    if (payload.scope !== 'verify') {
      throw new UnauthorizedException('Token de vérification invalide');
    }

    // Garantit l'unicité du phone et email même en race condition
    const conflicts = await this.prisma.deliverer.findFirst({
      where: {
        OR: [{ phone: payload.phone }, { email: dto.email }],
        entity_status: { not: EntityStatus.DELETED },
      },
    });
    if (conflicts) {
      throw new ConflictException('Un livreur avec ce numéro ou email existe déjà');
    }

    const hashedPassword = await bcrypt.hash(dto.password, AuthDelivererService.BCRYPT_ROUNDS);

    // Génération de reference avec retry sur collision (très improbable, 5 chiffres aléatoires)
    let deliverer: Deliverer | null = null;
    for (let attempt = 0; attempt < 3 && !deliverer; attempt++) {
      try {
        deliverer = await this.prisma.deliverer.create({
          data: {
            reference: this.generateDelivererReference(),
            phone: payload.phone,
            password: hashedPassword,
            first_name: dto.first_name,
            last_name: dto.last_name,
            email: dto.email,
            genre: dto.genre,
            type_vehicule: dto.type_vehicule,
            piece_identite: dto.piece_identite,
            permis_conduire: dto.permis_conduire,
            numero_permis: dto.numero_permis,
            numero_immatriculation: dto.numero_immatriculation,
            status: DelivererStatus.PENDING_VALIDATION,
            is_operational: false,
          },
        });
      } catch (err: any) {
        // P2002 = unique constraint violation. Si c'est la reference, on réessaie
        const isRefCollision =
          err?.code === 'P2002' &&
          Array.isArray(err?.meta?.target) &&
          err.meta.target.includes('reference');
        if (!isRefCollision) throw err;
      }
    }
    if (!deliverer) {
      throw new HttpException('Impossible de générer une référence unique', 500);
    }

    // I-admin : émet l'event "pending validation" → un listener côté
    // DeliverersModule envoie un email aux ADMIN actifs. Pas de await
    // (fire-and-forget) — un échec d'envoi email NE DOIT PAS bloquer
    // la finalisation de l'inscription.
    this.eventEmitter.emit('deliverer:pending-validation', { deliverer });

    return this.issueSession(deliverer, {
      pending_validation: true,
      message: "Inscription réussie. En attente de validation par l'administrateur.",
    });
  }

  // ============================================================
  // CONNEXION
  // ============================================================

  async login(dto: LoginDelivererDto) {
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { phone: dto.phone },
    });

    if (!deliverer || deliverer.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Livreur non trouvé');
    }
    if (deliverer.entity_status === EntityStatus.INACTIVE) {
      throw new UnauthorizedException('Compte livreur inactif');
    }
    if (deliverer.status === DelivererStatus.REJECTED) {
      throw new UnauthorizedException('Compte livreur refusé');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, deliverer.password);
    if (!isPasswordValid) {
      throw new BadRequestException('Mot de passe invalide');
    }

    await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: { last_login_at: new Date() },
    });

    // Compte programmé pour suppression : on délivre quand même la session,
    // mais on signale au mobile pour qu'il propose la restauration.
    // Si la grâce est expirée (rare car cron, mais possible), on refuse.
    if (deliverer.deletion_scheduled_at) {
      if (deliverer.deletion_scheduled_at <= new Date()) {
        throw new UnauthorizedException('Compte expiré');
      }
      return this.issueSession(deliverer, {
        deletion_scheduled_at: deliverer.deletion_scheduled_at,
        pending_deletion: true,
        message: `Votre compte est programmé pour suppression le ${deliverer.deletion_scheduled_at.toLocaleDateString('fr-FR')}. Restaurez-le pour continuer à l'utiliser.`,
      });
    }

    return this.issueSession(deliverer);
  }

  // ============================================================
  // MOT DE PASSE OUBLIÉ
  // ============================================================

  async forgotPassword(dto: RegisterPhoneDto) {
    const deliverer = await this.prisma.deliverer.findFirst({
      where: {
        phone: dto.phone,
        entity_status: { not: EntityStatus.DELETED },
      },
    });
    if (!deliverer) {
      throw new NotFoundException('Aucun compte livreur associé à ce numéro');
    }

    const otp = await this.otpService.generate(dto.phone);
    const isSent = await this.twilioService.sendOtp({ phoneNumber: dto.phone, otp });
    if (!isSent) {
      throw new HttpException("Envoi de l'OTP impossible", 500);
    }

    return { phone: dto.phone, message: 'Code OTP envoyé' };
  }

  async verifyResetOtp(dto: VerifyDelivererOtpDto) {
    await this.assertOtpValid(dto.phone, dto.otp);
    const resetToken = await this.jwt.generateDelivererResetToken(dto.phone);
    return { resetToken };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const payload = await this.jwt.verifyDelivererResetToken(dto.resetToken);
    if (payload.scope !== 'reset') {
      throw new UnauthorizedException('Token de réinitialisation invalide');
    }

    const deliverer = await this.prisma.deliverer.findFirst({
      where: {
        phone: payload.phone,
        entity_status: { not: EntityStatus.DELETED },
      },
    });
    if (!deliverer) {
      throw new NotFoundException('Livreur non trouvé');
    }

    const hashedPassword = await bcrypt.hash(dto.password, AuthDelivererService.BCRYPT_ROUNDS);

    const updated = await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: {
        password: hashedPassword,
        refresh_token: null, // révoque toutes les sessions
        last_login_at: new Date(),
      },
    });

    return this.issueSession(updated, { message: 'Mot de passe réinitialisé avec succès' });
  }

  // ============================================================
  // SESSION
  // ============================================================

  async refreshAccessToken(delivererId: string) {
    const token = await this.jwt.generateDelivererToken(delivererId);
    return { token };
  }

  async logout(delivererId: string) {
    await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { refresh_token: null },
    });
    return { message: 'Déconnexion réussie' };
  }

  async getMe(delivererId: string) {
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            latitude: true,
            longitude: true,
          },
        },
      },
    });
    if (!deliverer) {
      throw new NotFoundException('Livreur non trouvé');
    }
    const { password, refresh_token, ...rest } = deliverer;
    return rest;
  }

  // ============================================================
  // SUPPRESSION DE COMPTE (RGPD + période de grâce 90 jours)
  // ============================================================

  /**
   * Programmation de la suppression du compte.
   *
   * Comportement à 2 étapes (RGPD + Apple App Store) :
   *
   *  ÉTAPE 1 (cette méthode) — Suppression PROGRAMMÉE :
   *   - Vérifie le password
   *   - Set `deletion_scheduled_at = NOW + 90 jours`
   *   - Désactive le compte (is_operational = false, refresh_token = null)
   *   - PRÉSERVE les données (nom, email, documents) → permet la récupération
   *   - Émet l'event WS pour déconnexion immédiate côté mobile
   *
   *  ÉTAPE 2 (DeliverersTask cron, après 90j) — Suppression DÉFINITIVE :
   *   - Anonymise les PII
   *   - Marque entity_status = DELETED
   *   - (Optionnel) supprime les fichiers S3
   *
   *  Pendant les 90 jours, le user peut se reconnecter et appeler `restoreAccount()`.
   *  Au-delà, le compte est anonymisé mais la ligne reste en DB pour préserver
   *  l'intégrité référentielle (FK orders, etc.).
   */
  async deleteAccount(delivererId: string, dto: DeleteAccountDto) {
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
    });
    if (!deliverer || deliverer.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Livreur non trouvé');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, deliverer.password);
    if (!isPasswordValid) {
      throw new BadRequestException('Mot de passe invalide');
    }

    const scheduledAt = new Date(
      Date.now() + AuthDelivererService.DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );

    const updated = await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: {
        deletion_scheduled_at: scheduledAt,
        is_operational: false,
        refresh_token: null,
      },
      omit: { password: true, refresh_token: true },
    });

    this.eventEmitter.emit('deliverer:operational:changed', {
      deliverer: updated,
      previousStatus: deliverer.status,
      is_operational: false,
      reason: `Compte programmé pour suppression le ${scheduledAt.toLocaleDateString('fr-FR')}`,
    });

    this.logger.log(
      `Deliverer ${deliverer.id} a programmé sa suppression — effective le ${scheduledAt.toISOString()}`,
    );

    return {
      id: deliverer.id,
      scheduled: true,
      deletion_scheduled_at: scheduledAt,
      grace_period_days: AuthDelivererService.DELETION_GRACE_DAYS,
      message: `Votre compte sera définitivement supprimé le ${scheduledAt.toLocaleDateString('fr-FR')}. Vous pouvez le récupérer à tout moment d'ici là en vous reconnectant.`,
    };
  }

  /**
   * Annule une suppression programmée.
   * Permet à l'utilisateur de récupérer son compte pendant la période de grâce.
   */
  async restoreAccount(delivererId: string) {
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
    });
    if (!deliverer || deliverer.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Livreur non trouvé');
    }
    if (!deliverer.deletion_scheduled_at) {
      throw new BadRequestException("Ce compte n'est pas programmé pour suppression");
    }

    const restored = await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: {
        deletion_scheduled_at: null,
        // is_operational reste calculé selon status + restaurant_id
        is_operational: deliverer.status === DelivererStatus.ACTIVE && !!deliverer.restaurant_id,
      },
      omit: { password: true, refresh_token: true },
    });

    this.eventEmitter.emit('deliverer:operational:changed', {
      deliverer: restored,
      previousStatus: deliverer.status,
      is_operational: restored.is_operational,
      reason: 'Compte restauré',
    });

    this.logger.log(`Deliverer ${deliverer.id} a restauré son compte`);
    return { id: restored.id, restored: true, message: 'Votre compte a été restauré' };
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  /**
   * Vérifie qu'un OTP existe en DB et qu'il est valide via HOTP.
   * Utilisé par verify-otp ET verify-reset-otp.
   */
  private async assertOtpValid(phone: string, otp: string) {
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: otp,
        phone,
        expire: { gte: new Date() },
      },
    });
    if (!otpToken) {
      throw new UnauthorizedException('Code OTP invalide ou expiré');
    }

    const isVerified = await this.otpService.verify(otpToken.code);
    if (!isVerified) {
      throw new UnauthorizedException('Code OTP invalide');
    }
  }

  /**
   * Génère les tokens, stocke le hash du refresh en DB et retourne la session.
   *
   * ⚠ Le payload retourné **inclut le `restaurant` populé** (mêmes champs que
   * `getMe()`) afin que le mobile puisse afficher dès le login (ou refresh /
   * complete-registration / reset-password) le nom du restaurant dans le header
   * d'accueil et le modal de félicitations. Sinon au 2ᵉ login après logout, le
   * mobile écraserait le USER_PROFILE cache avec un user sans restaurant
   * peuplé → header « CN » et modal sans nom.
   */
  private async issueSession(deliverer: Deliverer, extra: Record<string, unknown> = {}) {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.generateDelivererToken(deliverer.id),
      this.jwt.generateDelivererRefreshToken(deliverer.id),
    ]);

    const hashedRefresh = await bcrypt.hash(refreshToken, AuthDelivererService.BCRYPT_ROUNDS);
    // On met à jour le refresh ET on récupère le deliverer avec le restaurant
    // peuplé en une seule requête pour éviter un round-trip supplémentaire.
    const updated = await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: { refresh_token: hashedRefresh },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            latitude: true,
            longitude: true,
          },
        },
      },
    });

    const { password, refresh_token, ...rest } = updated;
    return {
      deliverer: rest,
      token: accessToken,
      refreshToken,
      ...extra,
    };
  }
}
