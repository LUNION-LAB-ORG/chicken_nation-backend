import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CardRequestStatus, LoyaltyLevel, NationCardStatus, Prisma, ProfileType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CardRequestQueryDto, NationCardQueryDto } from '../dtos/card-query.dto';
import { CreateCardRequestDto } from '../dtos/create-card-request.dto';
import { ReviewCardRequestDto } from '../dtos/review-card-request.dto';
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
   * Créer une demande de carte (depuis l'app mobile)
   */
  async createRequest(
    customerId: string,
    createDto: CreateCardRequestDto,
    file?: Express.Multer.File,
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
      const card = await this.generateCard(updatedRequest);

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
  private async generateCard(requestCard: any) {
    try {
      const level: LoyaltyLevel | null = requestCard.customer.loyalty_level ?? null;
      const isStudent = requestCard.profile_type === ProfileType.ETUDIANT;

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

      // Propage le profil déclaré au CLIENT : c'est `Customer.profile_type` que
      // lit le filtre d'audience des menus (ETUDIANT → menus étudiants ; NULL =
      // grand public). Fait à la VALIDATION (carte active), pas à la demande.
      await this.prisma.customer.update({
        where: { id: requestCard.customer_id },
        data: { profile_type: requestCard.profile_type ?? null },
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