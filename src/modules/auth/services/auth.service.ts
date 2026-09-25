import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, HttpException, HttpStatus, ForbiddenException, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
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
import {
  canonicalizeCustomerPhone,
  customerPhoneVariants,
} from 'src/common/utils/customer-phone.util';
import {
  motifRefusCompte,
  statutApresConnexion,
} from 'src/modules/auth/helpers/staff-account-status.helper';
import {
  EtatEchecsConnexion,
  MESSAGE_IDENTIFIANTS_INCORRECTS,
  cleEchecsConnexion,
  etatApresEchec,
  lireEtatEchecs,
  messageBlocageConnexion,
  minutesRestantesBlocage,
  pourJournal,
} from 'src/modules/auth/helpers/connexion-echecs.helper';
import { FileParCle, avantDelai } from 'src/modules/auth/helpers/file-par-cle.helper';

// Haché bcrypt (coût 10, celui de genSalt) d'une chaîne aléatoire jetée :
// comparé quand l'email est inconnu, pour que la réponse prenne le même temps
// qu'un mauvais mot de passe. Ce n'est pas un secret, le résultat est ignoré.
const HACHE_FACTICE = '$2b$10$VgUroBqB..TnDIdhiX2VQeBUEG5eOkQg6wwu9gap66p/bgc7O9yhS';

// Au-delà, une opération du compteur d'échecs est abandonnée (Redis coupé ou
// saturé) : la connexion continue sans lui.
const DELAI_CACHE_CONNEXION_MS = 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Essais de connexion d'un même email traités un par un (voir FileParCle).
  private readonly essaisParEmail = new FileParCle();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonWebTokenService: JsonWebTokenService,
    private readonly otpService: OtpService,
    private readonly twilioService: TwilioService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) { }

  // LOGIN USER
  // Réponse identique (400) pour un email inconnu et un mauvais mot de passe,
  // avec le même coût bcrypt : ni le message ni le temps de réponse ne disent
  // si le compte existe. Le statut n'est contrôlé qu'APRÈS le mot de passe,
  // pour ne rien révéler d'un compte suspendu à un tiers.
  //
  // `origine` : adresse(s) de l'appelant, pour le journal seulement.
  async login(loginUserDto: LoginUserDto, origine?: string) {
    const cle = cleEchecsConnexion(loginUserDto.email);
    const journal = {
      email: pourJournal(loginUserDto.email),
      origine: pourJournal(origine || 'adresse inconnue'),
    };

    // Verrou, mot de passe et compteur passent un essai à la fois par email :
    // des essais parallèles liraient sinon tous le compteur avant le premier
    // échec écrit, et passeraient tous le verrou.
    const user = await this.essaisParEmail.executer(cle, () =>
      this.verifierIdentifiants(loginUserDto, cle, journal),
    );

    // Compte suspendu ou supprimé par un administrateur : pas de session.
    const motif = motifRefusCompte(user.entity_status);
    if (motif) {
      this.logger.warn(
        `Connexion refusée (compte ${user.entity_status}) : ${journal.email} depuis ${journal.origine}`,
      );
      throw new ForbiddenException(motif);
    }

    // Génération du token et du refreshToken
    const token = await this.jsonWebTokenService.generateToken(user.id);
    const refreshToken = await this.jsonWebTokenService.generateRefreshToken(user.id);

    // Date de connexion. Le statut ne change que pour un compte hérité NEW
    // (passé ACTIVE) : écrire ACTIVE à chaque connexion réactivait les comptes
    // suspendus.
    const statut = statutApresConnexion(user.entity_status);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date(), ...(statut ? { entity_status: statut } : {}) },
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

  /**
   * Contrôle du verrou, de l'email et du mot de passe, puis mise à jour du
   * compteur. Renvoie le membre du personnel si le mot de passe est juste, lève
   * 429 (email verrouillé) ou 400 (identifiants incorrects) sinon.
   */
  private async verifierIdentifiants(
    loginUserDto: LoginUserDto,
    cle: string,
    journal: { email: string; origine: string },
  ): Promise<User> {
    // Email verrouillé après trop d'échecs : refusé avant tout calcul.
    const minutes = minutesRestantesBlocage(
      await this.lireEchecsConnexion(cle),
      Date.now(),
    );
    if (minutes > 0) {
      this.logger.warn(
        `Connexion refusée (email verrouillé) : ${journal.email} depuis ${journal.origine}`,
      );
      throw new HttpException(messageBlocageConnexion(minutes), HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({
      where: { email: loginUserDto.email },
    });
    const isPasswordValid = await bcrypt.compare(
      loginUserDto.password,
      user?.password ?? HACHE_FACTICE,
    );
    if (!user || !isPasswordValid) {
      const minutesBlocage = await this.enregistrerEchecConnexion(cle);
      this.logger.warn(
        `Échec de connexion : ${journal.email} depuis ${journal.origine}${minutesBlocage > 0 ? ', email verrouillé' : ''}`,
      );
      if (minutesBlocage > 0) {
        throw new HttpException(messageBlocageConnexion(minutesBlocage), HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new BadRequestException(MESSAGE_IDENTIFIANTS_INCORRECTS);
    }
    await this.effacerEchecsConnexion(cle);
    return user;
  }

  // ── Compteur d'échecs de connexion du personnel (par email, dans Redis) ────
  // Best-effort : une panne du cache ne doit jamais empêcher de se connecter ;
  // la limite par IP (ConnexionThrottlerGuard) reste alors en place. Chaque
  // appel est borné dans le temps : pendant une coupure, le client Redis garde
  // les commandes en attente au lieu d'échouer.

  private async lireEchecsConnexion(cle: string): Promise<EtatEchecsConnexion | null> {
    try {
      return lireEtatEchecs(await avantDelai(this.cache.get(cle), DELAI_CACHE_CONNEXION_MS));
    } catch (error) {
      this.logger.error(`Lecture du compteur d'échecs de connexion impossible : ${String(error)}`);
      return null;
    }
  }

  /** Enregistre un échec et renvoie les minutes de verrou s'il atteint le plafond (0 sinon). */
  private async enregistrerEchecConnexion(cle: string): Promise<number> {
    try {
      // Relu ici plutôt qu'au début : un autre serveur a pu compter un échec
      // pendant bcrypt (dans ce processus, la file par email l'empêche).
      const suivant = etatApresEchec(await this.lireEchecsConnexion(cle), Date.now());
      await avantDelai(this.cache.set(cle, suivant.etat, suivant.ttlMs), DELAI_CACHE_CONNEXION_MS);
      return suivant.minutesBlocage;
    } catch (error) {
      this.logger.error(`Écriture du compteur d'échecs de connexion impossible : ${String(error)}`);
      return 0;
    }
  }

  private async effacerEchecsConnexion(cle: string): Promise<void> {
    try {
      await avantDelai(this.cache.del(cle), DELAI_CACHE_CONNEXION_MS);
    } catch {
      // best-effort : la clé expire d'elle-même.
    }
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
    // ⚠️ Lookup TOLÉRANT aux deux graphies (`+225…` app / `225…` adhésion site) :
    // le match exact créait un DOUBLON vide pour les comptes pré-inscrits via le
    // site → formulaire re-affiché + demande de carte invisible. On cherche
    // toutes les variantes, on écrit toujours le format canonique `+…`.
    const canonical = canonicalizeCustomerPhone(phone);
    const variants = customerPhoneVariants(phone);
    let customer = await this.prisma.customer.findFirst({
      where: {
        phone: { in: variants },
        entity_status: { not: EntityStatus.DELETED },
      },
      // Si un doublon existe malgré tout, privilégier la ligne canonique.
      orderBy: { created_at: 'asc' },
    });

    if (customer && customer.phone !== canonical) {
      // Auto-réparation : on normalise la ligne héritée (best-effort — si la
      // graphie canonique est déjà prise par un twin, on garde l'existante).
      try {
        customer = await this.prisma.customer.update({
          where: { id: customer.id },
          data: { phone: canonical },
        });
      } catch {
        /* conflit d'unicité → la migration de fusion s'en charge */
      }
    }

    if (!customer) {
      customer = await this.prisma.customer.create({ data: { phone: canonical } });
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
    /**
     * ⚠️ FAILLE CRITIQUE CORRIGEE : le code était renvoyé EN CLAIR dans la
     * réponse HTTP de cette route PUBLIQUE.
     *
     * Il suffisait d'appeler cette route avec un numéro pour lire le code dans
     * la réponse, puis de le rejouer sur `verify-otp` : prise de contrôle
     * complète de n'importe quel compte client à partir du seul numéro de
     * téléphone, sans jamais recevoir le SMS. Et comme la table des codes est
     * partagée avec le module livreur, le même appel ouvrait aussi la
     * réinitialisation d'un compte livreur.
     *
     * Le code ne doit exister que dans le SMS. L'application ne s'en servait
     * que pour l'afficher dans sa console.
     */
    return { phone: customer.phone, message: 'Code envoyé par SMS' };
  }

  // VERIFY OTP
  async verifyOtp(data: VerifyOtpDto) {
    // ── Durcissement : rejeter d'emblée si le numéro est verrouillé (trop
    // d'échecs récents) AVANT toute comparaison de code. ──────────────────
    await this.assertOtpNotLocked(data.phone);

    // Validation COMPLÈTE et suffisante : le token stocké correspond-il au
    // (téléphone + code) saisi, et n'est-il pas expiré ? Le token est stocké
    // sous la graphie DB du client (canonique `+…`, ou héritée `225…` si la
    // normalisation a rencontré un twin) → lookup tolérant aux variantes.
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: data.otp,
        phone: { in: customerPhoneVariants(data.phone) },
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
      where: {
        phone: { in: customerPhoneVariants(otpToken.phone) },
        entity_status: { not: EntityStatus.DELETED },
      },
      orderBy: { created_at: 'asc' },
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
