import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CardRequestStatus, LoyaltyLevel, NationCardStatus, Prisma, ProfileType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CardRequestQueryDto, NationCardQueryDto } from '../dtos/card-query.dto';
import { CreateCardRequestDto } from '../dtos/create-card-request.dto';
import { PreviewCardDto } from '../dtos/preview-card.dto';
import { CardType, ReviewCardRequestDto } from '../dtos/review-card-request.dto';
import { CardGenerationService } from './card-generation.service';
import { CardNotificationService } from './card-notification.service';
import { S3Service } from 'src/s3/s3.service';
import { TwilioService } from 'src/twilio/services/twilio.service';

@Injectable()
export class CardRequestService {
  private readonly logger = new Logger(CardRequestService.name);

  // Réglage backoffice : false = V1 (déclaratif, sans justificatif),
  // true = V2 (justificatif étudiant obligatoire). Défaut V1.
  // Dans les DEUX cas la demande est créée en PENDING et validée au backoffice.
  static readonly SETTING_REQUIRE_JUSTIFICATIF = 'card.require_justificatif';

  /**
   * URL de partage / deep link CANONIQUE (page smart-redirect app/store).
   * ⚠️ `www.` ET le préfixe `/fr/` sont OBLIGATOIRES.
   */
  private static readonly CANONICAL_DEEP_LINK =
    'https://www.chicken-nation.com/fr/app-mobile/deep-link';

  constructor(
    private prisma: PrismaService,
    private cardGenerationService: CardGenerationService,
    private readonly cardNotificationService: CardNotificationService,
    private readonly settingsService: SettingsService,
    private readonly s3service: S3Service,
    private readonly twilioService: TwilioService,
  ) { }

  /** Lit le réglage card.require_justificatif (défaut false = V1). */
  private async isJustificatifRequired(): Promise<boolean> {
    const value = await this.settingsService.get(
      CardRequestService.SETTING_REQUIRE_JUSTIFICATIF,
    );
    return value === 'true' || value === '1';
  }

  /**
   * Upload la photo du titulaire sur S3 → renvoie sa clé (ou null si absente/échec).
   * Accepte un fichier multipart (app) OU un data-URL base64 (site adhésion JSON).
   */
  private async uploadPhoto(
    input?: { file?: Express.Multer.File; base64?: string },
  ): Promise<string | null> {
    let buffer: Buffer | undefined;
    let mimetype = 'image/jpeg';
    let originalname = 'card-photo.jpg';

    if (input?.file?.buffer) {
      buffer = input.file.buffer;
      mimetype = input.file.mimetype || mimetype;
      originalname = input.file.originalname || originalname;
    } else if (input?.base64) {
      const decoded = this.decodeBase64Image(input.base64);
      if (decoded) {
        buffer = decoded.buffer;
        mimetype = decoded.mimetype;
        originalname = decoded.originalname;
      }
    }

    if (!buffer || buffer.length === 0) return null;

    const result = await this.s3service.uploadFile({
      buffer,
      path: 'chicken-nation/card-requests',
      originalname,
      mimetype,
    });
    return result?.key ?? null;
  }

  /** Décode un data-URL base64 (`data:image/...;base64,...`) ou du base64 brut. */
  private decodeBase64Image(
    dataUrl: string,
  ): { buffer: Buffer; mimetype: string; originalname: string } | null {
    const raw = (dataUrl || '').trim();
    if (!raw) return null;
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(raw);
    const mimetype = match ? match[1] : 'image/jpeg';
    const b64 = match ? match[2] : raw;
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (!buffer.length) return null;
      const ext = (mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      return { buffer, mimetype, originalname: `card-photo.${ext}` };
    } catch {
      return null;
    }
  }

  private static readonly LEVEL_BY_CARD_TYPE: Partial<Record<CardType, LoyaltyLevel>> = {
    [CardType.STANDARD]: LoyaltyLevel.STANDARD,
    [CardType.VIP]: LoyaltyLevel.VIP,
    [CardType.VVIP]: LoyaltyLevel.VVIP,
  };

  /**
   * Résout le thème de la carte (niveau + marqueur étudiant) depuis le TYPE choisi
   * au backoffice à l'approbation :
   *  - ETUDIANT           → carte étudiante (liseré jaune) ; couleur = niveau du client ;
   *  - STANDARD/VIP/VVIP  → ce niveau, non étudiante ;
   *  - aucun type fourni  → dérivation auto (niveau du client + profil déclaré).
   */
  private resolveCardTheme(
    cardType: CardType | undefined,
    customerLevel: LoyaltyLevel | null,
    declaredStudent = false,
  ): { level: LoyaltyLevel | null; isStudent: boolean } {
    if (cardType === CardType.ETUDIANT) {
      return { level: customerLevel ?? LoyaltyLevel.STANDARD, isStudent: true };
    }
    if (cardType) {
      return {
        level:
          CardRequestService.LEVEL_BY_CARD_TYPE[cardType] ?? LoyaltyLevel.STANDARD,
        isStudent: false,
      };
    }
    return { level: customerLevel, isStudent: declaredStudent };
  }

  /**
   * Créer une demande de carte (depuis l'app mobile)
   */
  async createRequest(
    customerId: string,
    createDto: CreateCardRequestDto,
    file?: Express.Multer.File,
    photoInput?: { file?: Express.Multer.File; base64?: string },
  ) {
    // Vérifier si une demande en attente existe déjà
    const existingRequest = await this.prisma.cardRequest.findFirst({
      where: {
        customer_id: customerId,
        status: {
          in: [CardRequestStatus.PENDING, CardRequestStatus.IN_REVIEW],
        },
      },
    });

    if (existingRequest) {
      throw new ConflictException('Vous avez déjà une demande en cours de traitement');
    }

    // Vérifier si le client a déjà une carte active
    const existingCard = await this.prisma.nationCard.findFirst({
      where: {
        customer_id: customerId,
        status: NationCardStatus.ACTIVE,
      },
    });

    if (existingCard) {
      throw new ConflictException('Vous possédez déjà une carte Nation active');
    }

    // Mise à jour du client si date de naissance renseignée (sert au numéro de carte).
    if (createDto.birth_day) {
      await this.prisma.customer.update({
        where: { id: customerId },
        data: { birth_day: createDto.birth_day },
      });
    }

    // Photo du titulaire (contrôle backoffice — affichée dans la modale Détail,
    // jamais reprise sur la carte). Uploadée sur S3 si fournie (fichier multipart
    // app/site, ou base64 en secours). NON bloquante ici pour rester
    // RÉTRO-COMPATIBLE avec l'app en prod tant que l'OTA (qui envoie la photo)
    // n'est pas publiée. L'exigence « obligatoire » est portée par les formulaires
    // (app + site) et, côté adhésion site, par le contrôle amont dans
    // AdhesionService.register. Placée après les gardes pour ne rien uploader en vain.
    const photoKey = await this.uploadPhoto(photoInput);

    const requireJustificatif = await this.isJustificatifRequired();

    /* ============================================================
       La Carte de la Nation N'EST PLUS émise automatiquement. Quel que
       soit le mode, on crée UNIQUEMENT une demande en statut PENDING.
       C'est le BACKOFFICE qui valide (reviewRequest → APPROVED) et c'est
       CETTE validation qui génère la carte + envoie « carte prête ».

       - V2 (card.require_justificatif=true) : institution + justificatif
         obligatoires (uploadés sur S3).
       - V1 (défaut) : déclaratif, sans justificatif ni institution requis.
    ============================================================ */
    let cardRequest;
    let mode: 'V1' | 'V2';

    if (requireJustificatif) {
      if (!createDto.institution) {
        throw new BadRequestException("Le nom de l'établissement est requis");
      }
      if (!file) {
        throw new BadRequestException('Le justificatif étudiant est requis');
      }

      const result = await this.s3service.uploadFile({
        buffer: file.buffer,
        path: 'chicken-nation/carte-etudiant',
        originalname: file.originalname,
        mimetype: file.mimetype,
      });

      cardRequest = await this.prisma.cardRequest.create({
        data: {
          customer_id: customerId,
          nickname: createDto.nickname,
          profile_type: createDto.profile_type ?? null,
          institution: createDto.institution,
          student_card_file_url: result?.key ?? '',
          photo: photoKey,
          status: CardRequestStatus.PENDING,
        },
        include: {
          customer: {
            select: { id: true, first_name: true, last_name: true, phone: true, email: true },
          },
        },
      });
      mode = 'V2';
    } else {
      cardRequest = await this.prisma.cardRequest.create({
        data: {
          customer_id: customerId,
          nickname: createDto.nickname,
          profile_type: createDto.profile_type ?? null,
          institution: createDto.institution ?? null,
          student_card_file_url: null,
          photo: photoKey,
          status: CardRequestStatus.PENDING,
        },
        include: {
          customer: {
            select: { id: true, first_name: true, last_name: true, phone: true, email: true },
          },
        },
      });
      mode = 'V1';
    }

    // Accusé de réception « demande reçue » — PUSH + cloche best-effort (ne
    // bloque jamais la création). PAS de « carte prête » ici (validation only).
    this.cardNotificationService
      .notifyRequestReceived(customerId)
      .catch((e) => this.logger.warn(`notifyRequestReceived échouée : ${e?.message}`));

    return {
      success: true,
      mode,
      message: 'Votre demande de carte a bien été reçue',
      data: { request: cardRequest },
    };
  }

  /**
   * Obtenir la demande du client connecté
   */
  async getMyRequest(customerId: string) {
    const request = await this.prisma.cardRequest.findFirst({
      where: { customer_id: customerId },
      orderBy: { created_at: 'desc' },
      include: {
        nation_card: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Vous n\'avez pas encore de demande de carte Nation active');
    }

    return request;
  }

  /**
   * Obtenir la carte Nation du client, enrichie du niveau, du marqueur ETUDIANT
   * et de la progression vers le niveau suivant.
   *
   * Régénération PARESSEUSE : si le snapshot `level`/`is_student` de la carte ne
   * correspond plus au niveau courant du client (ex. après le reset annuel du
   * status_points, non couvert par le listener level-up), on régénère l'image ici.
   */
  async getMyCard(customerId: string) {
    let card = await this.prisma.nationCard.findFirst({
      where: {
        customer_id: customerId,
        status: NationCardStatus.ACTIVE,
      },
      include: {
        customer: {
          select: {
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            loyalty_level: true,
            status_points: true,
          },
        },
        card_request: {
          select: {
            institution: true,
            profile_type: true,
            reviewed_at: true,
            created_at: true,
          },
        },
      },
    });

    if (!card) {
      throw new NotFoundException('Vous n\'avez pas encore de carte Nation active');
    }

    // Régénération paresseuse best-effort (couvre le reset annuel).
    if (card.level !== (card.customer.loyalty_level ?? null)) {
      try {
        const regenerated = await this.regenerateActiveCard(customerId);
        if (regenerated) {
          card = { ...card, ...regenerated } as typeof card;
        }
      } catch (e) {
        this.logger.warn(`Régénération paresseuse carte échouée : ${(e as Error)?.message}`);
      }
    }

    const progression = await this.getLevelProgression(
      card.customer.loyalty_level ?? null,
      card.customer.status_points ?? 0,
    );

    return {
      ...card,
      level: card.level,
      is_student: card.is_student,
      progression,
    };
  }

  /**
   * Calcule la progression de fidélité (niveau courant + prochain palier).
   * Lit les seuils depuis LoyaltyConfig sans dépendre du module fidelity (évite
   * un cycle de modules). Indépendant du niveau actuel : le prochain palier est
   * déterminé par le premier seuil au-dessus de status_points.
   */
  private async getLevelProgression(level: LoyaltyLevel | null, statusPoints: number) {
    const config = await this.prisma.loyaltyConfig.findFirst({ where: { is_active: true } });
    const thresholds = {
      STANDARD: config?.standard_threshold ?? 300,
      VIP: config?.premium_threshold ?? 700,
      VVIP: config?.gold_threshold ?? 1000,
    };

    const ladder: Array<{ level: LoyaltyLevel; points: number }> = [
      { level: LoyaltyLevel.STANDARD, points: thresholds.STANDARD },
      { level: LoyaltyLevel.VIP, points: thresholds.VIP },
      { level: LoyaltyLevel.VVIP, points: thresholds.VVIP },
    ];
    const next = ladder.find((l) => statusPoints < l.points);

    return {
      current_level: level,
      status_points: statusPoints,
      next_level: next?.level ?? null,
      points_to_next_level: next ? Math.max(0, next.points - statusPoints) : 0,
      thresholds,
    };
  }

  /**
   * Liste toutes les demandes (backoffice)
   */
  async getAllRequests(query: CardRequestQueryDto) {
    const { page = 1, limit = 10, search, status, institution } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.CardRequestWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (institution) {
      where.institution = { contains: institution, mode: 'insensitive' };
    }

    if (search) {
      where.OR = [
        { institution: { contains: search, mode: 'insensitive' } },
        { nickname: { contains: search, mode: 'insensitive' } },
        { customer: { first_name: { contains: search, mode: 'insensitive' } } },
        { customer: { last_name: { contains: search, mode: 'insensitive' } } },
        { customer: { phone: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [requests, total] = await Promise.all([
      this.prisma.cardRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
              birth_day: true,
            },
          },
          nation_card: true,
        },
      }),
      this.prisma.cardRequest.count({ where }),
    ]);

    return {
      data: requests,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Détails d'une demande (backoffice)
   */
  async getRequestById(id: string) {
    const request = await this.prisma.cardRequest.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            birth_day: true,
            image: true,
          },
        },
        nation_card: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Demande non trouvée');
    }

    return request;
  }

  /**
   * Valider ou rejeter une demande (backoffice)
   */
  async reviewRequest(id: string, userId: string, reviewDto: ReviewCardRequestDto) {
    const request = await this.prisma.cardRequest.findUnique({
      where: { id },
      include: {
        customer: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Demande non trouvée');
    }

    if (request.status !== CardRequestStatus.PENDING && request.status !== CardRequestStatus.IN_REVIEW) {
      throw new BadRequestException('Cette demande a déjà été traitée');
    }

    // Mise à jour de la demande
    const updatedRequest = await this.prisma.cardRequest.update({
      where: { id },
      data: {
        status: reviewDto.status,
        rejection_reason: reviewDto.rejection_reason,
        reviewed_by: userId,
        reviewed_at: new Date(),
      },
      include: {
        customer: true,
      },
    });

    // Si approuvée : générer la carte + notifier. C'est le SEUL endroit d'où
    // part « carte prête » (push/cloche/WS + WhatsApp). Best-effort.
    if (reviewDto.status === CardRequestStatus.APPROVED) {
      const card = await this.generateCard(updatedRequest, reviewDto.card_type);

      this.cardNotificationService
        .notifyCardReady(updatedRequest.customer_id, card.level)
        .catch((e) => this.logger.warn(`notifyCardReady échouée : ${e?.message}`));

      // Template WhatsApp Meta « carte prête » (best-effort) — UNIQUEMENT à la
      // validation. Dégrade proprement si le template n'est pas approuvé.
      const phone = updatedRequest.customer?.phone;
      if (phone) {
        this.twilioService
          .sendCardReady({
            phoneNumber: phone,
            firstName: (updatedRequest.customer?.first_name || 'Client').split(' ')[0],
            deepLink: CardRequestService.CANONICAL_DEEP_LINK,
          })
          .catch((e) => this.logger.warn(`sendCardReady (WhatsApp) échoué : ${e?.message}`));
      }
    } else if (reviewDto.status === CardRequestStatus.REJECTED) {
      // Refus → notifier le client (push + cloche + WS temps réel). Best-effort,
      // ne bloque jamais la réponse backoffice.
      this.cardNotificationService
        .notifyCardRejected(updatedRequest.customer_id)
        .catch((e) => this.logger.warn(`notifyCardRejected échouée : ${e?.message}`));
    }


    return {
      success: true,
      message: reviewDto.status === CardRequestStatus.APPROVED
        ? 'Demande approuvée et carte générée avec succès'
        : 'Demande rejetée',
      data: updatedRequest,
    };
  }

  /**
   * Génère une carte Nation après approbation.
   * Snapshot le niveau de fidélité (thème couleur) + le marqueur ETUDIANT.
   */
  private async generateCard(requestCard: any, cardType?: CardType) {
    try {
      // Type de carte CHOISI au backoffice à l'approbation (prioritaire) ; à
      // défaut, dérivation auto depuis le client (rétro-compat).
      const { level, isStudent } = this.resolveCardTheme(
        cardType,
        requestCard.customer.loyalty_level ?? null,
        requestCard.profile_type === ProfileType.ETUDIANT,
      );

      const cardNumber = this.cardGenerationService.generateCardNumber(requestCard.customer.birth_day);
      const qrCodeValue = this.cardGenerationService.generateQRValue(
        cardNumber,
        requestCard.customer_id,
      );
      // Prendre le premier prénom si plusieurs
      const firstName = requestCard.customer.first_name.split(' ')[0];
      const cardImagePath = await this.cardGenerationService.generateCardImage(
        firstName,
        requestCard.customer.last_name || '',
        cardNumber,
        qrCodeValue,
        requestCard.nickname,
        { level, is_student: isStudent },
      );

      const card = await this.prisma.nationCard.create({
        data: {
          customer_id: requestCard.customer_id,
          card_request_id: requestCard.id,
          nickname: requestCard.nickname,
          card_number: cardNumber,
          qr_code_value: qrCodeValue,
          card_image_url: cardImagePath,
          level,
          is_student: isStudent,
          status: NationCardStatus.ACTIVE,
        },
      });

      // Propage le profil au CLIENT : c'est `Customer.profile_type` que lit le
      // filtre d'audience des menus (ETUDIANT → menus étudiants ; NULL = grand
      // public). Fait à la VALIDATION (carte active), pas à la demande.
      // Si le staff a CHOISI un type de carte, c'est lui qui fait foi (émettre une
      // carte étudiante ⇒ profil étudiant) ; sinon on garde le profil déclaré.
      const resolvedProfile = cardType
        ? cardType === CardType.ETUDIANT
          ? ProfileType.ETUDIANT
          : null
        : (requestCard.profile_type ?? null);
      await this.prisma.customer.update({
        where: { id: requestCard.customer_id },
        data: { profile_type: resolvedProfile },
      });

      return card;

    } catch (error) {
      this.logger.error(`Erreur génération carte : ${(error as Error)?.message}`, (error as Error)?.stack);
      throw new BadRequestException('Erreur lors de la génération de la carte');
    }
  }

  /**
   * Régénère l'image de la carte ACTIVE d'un client pour refléter son niveau de
   * fidélité courant (thème couleur) et son marqueur ETUDIANT. Réutilise le
   * numéro de carte et le QR existants (identité inchangée). No-op si rien n'a
   * changé. Retourne la carte (mise à jour ou inchangée), ou null s'il n'y en a pas.
   */
  async regenerateActiveCard(customerId: string, newLevel?: LoyaltyLevel | null) {
    const card = await this.prisma.nationCard.findFirst({
      where: { customer_id: customerId, status: NationCardStatus.ACTIVE },
      include: {
        customer: { select: { first_name: true, last_name: true, loyalty_level: true } },
        card_request: { select: { profile_type: true } },
      },
    });
    if (!card) return null;

    // Niveau cible : celui porté par l'event de level-up (FIABLE même si la transaction
    // loyalty n'est pas encore commitée → sinon on relirait l'ancien niveau et la régén
    // serait un no-op). En régénération paresseuse (getMyCard), newLevel est absent → on
    // prend le niveau courant en base.
    const level: LoyaltyLevel | null =
      newLevel !== undefined ? newLevel : (card.customer.loyalty_level ?? null);
    const isStudent = card.card_request.profile_type === ProfileType.ETUDIANT;

    // Rien à régénérer : le snapshot est déjà à jour.
    if (card.level === level && card.is_student === isStudent) return card;

    const firstName = (card.customer.first_name || '').split(' ')[0];
    const newImage = await this.cardGenerationService.generateCardImage(
      firstName,
      card.customer.last_name || '',
      card.card_number,
      card.qr_code_value,
      card.nickname ?? undefined,
      { level, is_student: isStudent },
    );

    return this.prisma.nationCard.update({
      where: { id: card.id },
      data: { level, is_student: isStudent, card_image_url: newImage },
    });
  }

  /**
   * Liste de toutes les cartes (backoffice)
   */
  async getAllCards(query: NationCardQueryDto) {
    const { page = 1, limit = 10, search, status, institution } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.NationCardWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { card_number: { contains: search, mode: 'insensitive' } },
        { nickname: { contains: search, mode: 'insensitive' } },
        { customer: { first_name: { contains: search, mode: 'insensitive' } } },
        { customer: { last_name: { contains: search, mode: 'insensitive' } } },
        { customer: { phone: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (institution) {
      where.card_request = {
        institution: { contains: institution, mode: 'insensitive' },
      };
    }

    const [cards, total] = await Promise.all([
      this.prisma.nationCard.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              image: true,
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
              birth_day: true,
            },
          },
          card_request: {
            select: {
              id: true,
              institution: true,
              student_card_file_url: true,
              rejection_reason: true,
              reviewed_at: true,
              reviewed_by: true,
              status: true,
              created_at: true,
            },
          },
        },
      }),
      this.prisma.nationCard.count({ where }),
    ]);

    return {
      data: cards,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Détails d'une carte (backoffice)
   */
  async getCardById(id: string) {
    const card = await this.prisma.nationCard.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            image: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            birth_day: true,
          },
        },
        card_request: {
          select: {
            id: true,
            institution: true,
            student_card_file_url: true,
            rejection_reason: true,
            reviewed_at: true,
            reviewed_by: true,
            status: true,
            created_at: true,
          }
        },
      },
    });

    if (!card) {
      throw new NotFoundException('Carte non trouvée');
    }

    return card;
  }

  /**
   * Suspendre ou révoquer une carte
   */
  async updateCardStatus(id: string, status: NationCardStatus) {
    const card = await this.prisma.nationCard.findUnique({
      where: { id },
    });

    if (!card) {
      throw new NotFoundException('Carte non trouvée');
    }

    const updatedCard = await this.prisma.nationCard.update({
      where: { id },
      data: { status },
    });


    return {
      success: true,
      message: `Carte ${status === NationCardStatus.SUSPENDED ? 'suspendue' : 'révoquée'} avec succès`,
      data: updatedCard,
    };
  }

  /**
   * SUPPRIME DÉFINITIVEMENT une demande de carte (backoffice).
   * La carte éventuellement générée référence la demande (FK onDelete: Restrict) :
   * elle est donc supprimée AVANT, dans la même transaction. Les fichiers S3
   * (image de carte, photo, justificatif) sont nettoyés après commit, en best-effort.
   * ⚠️ Irréversible.
   */
  async deleteRequest(id: string) {
    const request = await this.prisma.cardRequest.findUnique({
      where: { id },
      include: { nation_card: true },
    });

    if (!request) {
      throw new NotFoundException('Demande non trouvée');
    }

    await this.prisma.$transaction(async (tx) => {
      if (request.nation_card) {
        await tx.nationCard.delete({ where: { id: request.nation_card.id } });
      }
      await tx.cardRequest.delete({ where: { id } });
    });

    await this.deleteS3Files([
      request.nation_card?.card_image_url,
      request.photo,
      request.student_card_file_url,
    ]);

    return {
      success: true,
      message: request.nation_card
        ? 'Demande et carte associée supprimées définitivement'
        : 'Demande supprimée définitivement',
    };
  }

  /**
   * SUPPRIME DÉFINITIVEMENT une carte générée + son image S3.
   * ⚠️ Irréversible. Pour un retrait réversible, utiliser `revoke` (statut REVOKED).
   */
  async deleteCard(id: string) {
    const card = await this.prisma.nationCard.findUnique({ where: { id } });

    if (!card) {
      throw new NotFoundException('Carte non trouvée');
    }

    await this.prisma.nationCard.delete({ where: { id } });
    await this.deleteS3Files([card.card_image_url]);

    return { success: true, message: 'Carte supprimée définitivement' };
  }

  /** Suppression S3 best-effort : un échec est loggé, jamais propagé. */
  private async deleteS3Files(keys: (string | null | undefined)[]) {
    await Promise.all(
      keys
        .filter((key): key is string => !!key)
        .map((key) =>
          this.s3service
            .deleteFile(key)
            .catch((e) =>
              this.logger.warn(`Suppression S3 échouée (${key}) : ${e?.message}`),
            ),
        ),
    );
  }

  /**
   * Aperçu d'un design de carte (galerie des designs / testeur de génération).
   * Rend l'image avec le VRAI générateur en mode render-only : aucune écriture en
   * base, aucun upload S3. Renvoie un data-URL base64 directement affichable.
   */
  async previewCard(dto: PreviewCardDto) {
    const { level, isStudent } = this.resolveCardTheme(dto.card_type, null);

    const image = await this.cardGenerationService.generateCardImage(
      dto.first_name || 'Awa',
      dto.last_name || 'Koné',
      '0101 2712 3456 7890',
      'APERCU-CARTE-NATION',
      dto.nickname || 'Jojo',
      { level, is_student: isStudent },
      true,
    );

    return {
      success: true,
      data: { card_type: dto.card_type, level, is_student: isStudent, image },
    };
  }

  /**
   * Exporter la liste des cartes en Excel (pour KLYEO)
   */
  async exportCardsToExcel(query: NationCardQueryDto) {
    const { search, status, institution } = query;

    const where: Prisma.NationCardWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { card_number: { contains: search, mode: 'insensitive' } },
        { nickname: { contains: search, mode: 'insensitive' } },
        { customer: { first_name: { contains: search, mode: 'insensitive' } } },
        { customer: { last_name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (institution) {
      where.card_request = {
        institution: { contains: institution, mode: 'insensitive' },
      };
    }

    const cards = await this.prisma.nationCard.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        customer: {
          select: {
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            birth_day: true,
          },
        },
        card_request: {
          select: {
            institution: true,
          },
        },
      },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Cartes Nation');

    // En-têtes
    worksheet.columns = [
      { header: 'Numéro de carte', key: 'card_number', width: 25 },
      { header: 'Prénom', key: 'first_name', width: 20 },
      { header: 'Nom', key: 'last_name', width: 20 },
      { header: 'Surnom', key: 'nickname', width: 20 },
      { header: 'Téléphone', key: 'phone', width: 15 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Date de naissance', key: 'birth_day', width: 15 },
      { header: 'Établissement', key: 'institution', width: 35 },
      { header: 'Statut', key: 'status', width: 12 },
      { header: 'Date de création', key: 'created_at', width: 20 },
    ];

    // Style de l'en-tête
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3B82F6' },
    };

    // Données
    cards.forEach((card) => {
      worksheet.addRow({
        card_number: card.card_number,
        first_name: card.customer.first_name || '',
        last_name: card.customer.last_name || '',
        nickname: card.nickname || '',
        phone: card.customer.phone,
        email: card.customer.email || '',
        birth_day: card.customer.birth_day ? new Date(card.customer.birth_day).toLocaleDateString('fr-FR') : '',
        institution: card.card_request.institution,
        status: card.status,
        created_at: new Date(card.created_at).toLocaleString('fr-FR'),
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();

    return {
      buffer,
      filename: `cartes-nation-${new Date().toISOString().split('T')[0]}.xlsx`,
    };
  }
}