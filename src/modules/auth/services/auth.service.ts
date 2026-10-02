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
  customerPhoneVariants,
  normaliserTelephoneClient,
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
import { MESSAGE_NUMERO_INVALIDE, messageDelaiEnvoi } from '../helpers/envois-otp.helper';
import { EnvoisOtpService } from '../otp/envois-otp.service';
import { TentativesLivreurService } from 'src/modules/auth-deliverer/services/tentatives-livreur.service';
import {
  POLITIQUE_CODE,
  cleVerificationCode,
  doitVerrouiller,
} from 'src/modules/auth-deliverer/helpers/tentatives-livreur.helper';

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
    private readonly envoisOtp: EnvoisOtpService,
    private readonly tentatives: TentativesLivreurService,
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

  // LOGIN CUSTOMER
  async loginCustomer(phone: string) {
    // Numéro inexploitable : 400, sans rien compter ni créer.
    const canonical = normaliserTelephoneClient(phone);
    if (!canonical) throw new BadRequestException(MESSAGE_NUMERO_INVALIDE);

    // ⚠️ Lookup TOLÉRANT aux deux graphies (`+225…` app / `225…` adhésion site) :
    // le match exact créait un DOUBLON vide pour les comptes pré-inscrits via le
    // site → formulaire re-affiché + demande de carte invisible. On cherche
    // toutes les variantes, on écrit toujours le format canonique `+…`.
    // Lecture seule, AVANT les plafonds : un client connu n'est pas soumis au
    // plafond commun des numéros inconnus (voir envois-otp.helper).
    let customer = await this.prisma.customer.findFirst({
      where: {
        phone: { in: customerPhoneVariants(canonical) },
        entity_status: { not: EntityStatus.DELETED },
      },
      // Si un doublon existe malgré tout, privilégier la ligne canonique.
      orderBy: { created_at: 'asc' },
    });

    // Délai et plafonds d'envoi AVANT toute écriture : un appel refusé ne crée
    // pas de compte et ne coûte pas de message. « Connu » = a déjà validé un
    // code sur ce numéro (un compte créé par une simple demande ne compte pas,
    // sinon chaque numéro inventé échapperait au plafond commun dès son
    // deuxième envoi).
    const demande = {
      telephone: canonical,
      compteConnu: !!customer?.last_login_at,
      delaiMs: AuthService.OTP_RESEND_COOLDOWN_MS,
    };
    return this.envoisOtp.encadrerEnvoi(demande, async () => {
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

      // Anti-flood en base, seconde barrière (Redis indisponible) : si un code a
      // été envoyé il y a moins de COOLDOWN, on refuse d'en générer/envoyer un
      // nouveau (le précédent reste valide 5 min).
      const wait = await this.otpService.getResendCooldownSeconds(
        customer.phone,
        AuthService.OTP_RESEND_COOLDOWN_MS,
      );
      if (wait > 0) {
        throw new HttpException(messageDelaiEnvoi(wait), 429);
      }

      const otp = await this.otpService.generate(customer.phone);
      const isSent = await this.twilioService.sendOtp({ phoneNumber: customer.phone, otp });
      if (!isSent) {
        // Rien n'est parti : on retire le code créé (encadrerEnvoi lève le
        // délai), sinon la nouvelle tentative serait refusée par « Un code
        // vient d'être envoyé ».
        try {
          await this.prisma.otpToken.deleteMany({ where: { phone: customer.phone, code: otp } });
        } catch (error) {
          this.logger.error(`Retrait du code non envoyé impossible : ${String(error)}`);
        }
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
    });
  }

  // VERIFY OTP
  // Durcissement (code à 4 chiffres, 10 000 combinaisons) : 5 essais par
  // numéro en 15 minutes, puis 429 pendant 15 minutes (POLITIQUE_CODE).
  //
  // ⚠️ Le numéro est ramené à UNE clé canonique avant tout : le verrou était
  // indexé sur la saisie brute alors que la recherche du code tolère toutes
  // les graphies, si bien que `+225 07…`, `22507…`, `+22507-…` avaient chacune
  // leurs 5 essais sur le même code (prise de compte en quelques milliers de
  // requêtes). La clé est aussi celle de la vérification livreur
  // (`cleVerificationCode`) : la table des codes est commune, le compteur aussi.
  //
  // L'essai est compté AVANT d'être jugé, par un incrément atomique en base :
  // des essais simultanés reçoivent chacun leur rang et seuls les 5 premiers
  // sont examinés (TentativesLivreurService).
  async verifyOtp(data: VerifyOtpDto) {
    const telephone = normaliserTelephoneClient(data.phone);
    // Aucun code n'a pu être envoyé à un numéro inexploitable : 400, sans
    // rien compter ni chercher (même réponse que la demande de code).
    if (!telephone) throw new BadRequestException(MESSAGE_NUMERO_INVALIDE);

    const maintenant = new Date();
    const cle = cleVerificationCode(telephone);
    const rang = await this.tentatives.reserver(cle, POLITIQUE_CODE, maintenant);

    // Validation COMPLÈTE et suffisante : le token stocké correspond-il au
    // (téléphone + code) saisi, et n'est-il pas expiré ? Le token est stocké
    // sous la graphie DB du client (canonique `+…`, ou héritée `225…` si la
    // normalisation a rencontré un twin) → lookup tolérant aux variantes.
    const variantes = customerPhoneVariants(telephone);
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        code: data.otp,
        phone: { in: variantes },
        expire: { gte: maintenant },
      },
    });

    if (!otpToken) {
      if (doitVerrouiller(rang, POLITIQUE_CODE)) {
        // Plafond atteint : verrou, et les codes en cours du numéro sont
        // retirés. Un code exposé à 5 essais n'est plus jamais accepté.
        await this.tentatives.constaterEchec(cle, rang, POLITIQUE_CODE, maintenant);
        await this.retirerCodes(variantes);
      }
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

    // Succès : on remet à zéro le compteur d'essais.
    await this.tentatives.effacer(cle);

    return { ...rest, token };
  }

  /** Retire les codes en cours d'un numéro (toutes graphies). Best-effort. */
  private async retirerCodes(variantes: string[]): Promise<void> {
    try {
      await this.prisma.otpToken.deleteMany({ where: { phone: { in: variantes } } });
    } catch (error) {
      this.logger.error(`Retrait des codes après verrou impossible : ${String(error)}`);
    }
  }

  // REFRESH TOKEN
  async refreshToken(req: Request) {
    const user = req.user as User;
    const token = await this.jsonWebTokenService.generateToken(user.id);
    return { token };
  }
}
