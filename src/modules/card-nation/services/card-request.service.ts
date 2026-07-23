import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CardRequestStatus, LoyaltyLevel, NationCardStatus, Prisma, ProfileType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CardRequestQueryDto, NationCardQueryDto } from '../dtos/card-query.dto';
import { CreateCardRequestDto } from '../dtos/create-card-request.dto';
import { PreviewCardDto } from '../dtos/preview-card.dto';
import { ReviewCardRequestDto } from '../dtos/review-card-request.dto';
import { CardGenerationService } from './card-generation.service';
import { CardNotificationService } from './card-notification.service';
import { S3Service } from 'src/s3/s3.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

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
   * `?to=nation-card` : app installée → le DeepLinkManager route directement
   * vers la page « Carte de la Nation » (sinon la page smart-redirect propose
   * les stores, comportement inchangé).
   */
  private static readonly CANONICAL_DEEP_LINK =
    'https://www.chicken-nation.com/fr/app-mobile/deep-link?to=nation-card';

  constructor(
    private prisma: PrismaService,
    private cardGenerationService: CardGenerationService,
    private readonly cardNotificationService: CardNotificationService,
    private readonly settingsService: SettingsService,
    private readonly s3service: S3Service,
    private readonly twilioService: TwilioService,
    private readonly appGateway: AppGateway,
  ) { }

  /**
   * Temps réel client : signale à l'app que SON état carte a changé (demande
   * soumise / validée / refusée, carte suspendue, réactivée, régénérée…).
   * L'app invalide ses caches TanStack → l'écran « Carte de la Nation » se met
   * à jour sans relancer l'app. Fire-and-forget, jamais bloquant.
   */
  private emitCardUpdated(customerId: string, reason: string) {
    try {
      this.appGateway.emitToUser(customerId, 'customer', 'card:updated', {
        reason,
        at: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn(`emit card:updated (${reason}) échoué : ${(e as Error)?.message}`);
    }
  }

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

  /**
   * Alloue un numéro de carte UNIQUE (`CN-XXXXXX`).
   * Le générateur est aléatoire : on vérifie la contrainte `card_number @unique`
   * et on régénère en cas de collision (improbable : ~887 M combinaisons).
   */
  private async allocateCardNumber(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = this.cardGenerationService.generateCardNumber();
      const exists = await this.prisma.nationCard.findUnique({
        where: { card_number: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw new BadRequestException(
      "Impossible d'allouer un numéro de carte unique, veuillez réessayer",
    );
  }

  /**
   * Motif d'une demande de RÉVISION, généré automatiquement en comparant la
   * demande à la carte existante → le staff voit immédiatement ce qui change,
   * sans que le client ait à l'écrire. (Demandes issues de l'app.)
   */
  private buildRevisionReason(
    card: { nickname: string | null; is_student: boolean },
    createDto: CreateCardRequestDto,
    hasNewPhoto: boolean,
  ): string {
    const parts: string[] = [];

    if (hasNewPhoto) parts.push('Changement de photo');

    const newNickname = createDto.nickname?.trim();
    if (newNickname && newNickname !== (card.nickname ?? '')) {
      parts.push(`Nouveau pseudo : ${newNickname}`);
    }

    const wantsStudent = createDto.profile_type === ProfileType.ETUDIANT;
    if (wantsStudent !== card.is_student) {
      parts.push(
        wantsStudent ? 'Demande le statut étudiant' : 'Retrait du statut étudiant',
      );
    }

    return parts.length
      ? parts.join(' · ')
      : 'Demande de régénération de la carte';
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

    // Carte active ? → ce n'est PAS un refus : c'est une demande de RÉVISION
    // (le client modifie sa photo / son pseudo / son statut étudiant depuis l'app).
    // Elle repart dans la liste des demandes en IN_REVIEW avec un motif auto-généré,
    // et c'est la validation backoffice qui régénérera la carte existante.
    const existingCard = await this.prisma.nationCard.findFirst({
      where: {
        customer_id: customerId,
        status: NationCardStatus.ACTIVE,
      },
      include: { card_request: { select: { photo: true } } },
    });
    const isRevision = !!existingCard;

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

    // Révision : statut IN_REVIEW + motif auto-généré (ce que le client change).
    // Sinon : PENDING classique (1ʳᵉ demande).
    const status = isRevision
      ? CardRequestStatus.IN_REVIEW
      : CardRequestStatus.PENDING;
    const revisionReason = isRevision
      ? this.buildRevisionReason(existingCard!, createDto, !!photoKey)
      : null;
    // Révision sans nouvelle photo → on reconduit celle de la carte actuelle,
    // sinon la carte régénérée perdrait son visage.
    const effectivePhoto =
      photoKey ?? (isRevision ? (existingCard!.card_request?.photo ?? null) : null);

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
          photo: effectivePhoto,
          status,
          revision_reason: revisionReason,
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
          photo: effectivePhoto,
          status,
          revision_reason: revisionReason,
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
    this.emitCardUpdated(customerId, 'request_submitted');

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
    // ⚠️ Comparaison sur le niveau VISUEL résolu (NOUVEAU/null → thème STANDARD,
    // cf. app resolveCardLevel) : comparer les valeurs brutes rendait la
    // condition TOUJOURS vraie pour un client sans palier (card.level='STANDARD'
    // vs loyalty_level=null) → rendu PNG + upload S3 à CHAQUE consultation.
    const visualLevel = (l: LoyaltyLevel | null) =>
      l === LoyaltyLevel.VIP || l === LoyaltyLevel.VVIP ? l : LoyaltyLevel.STANDARD;
    if (visualLevel(card.level) !== visualLevel(card.customer.loyalty_level ?? null)) {
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
   * Applique une demande de RÉVISION validée : on ne crée PAS une 2e carte, on
   * RÉGÉNÈRE la carte active avec les nouvelles données (photo, pseudo, niveau,
   * marqueur). Numéro et QR conservés → l'identité de la carte ne change pas.
   */
  private async applyRevision(
    requestCard: any,
    chosenLevel?: LoyaltyLevel,
    chosenIsStudent?: boolean,
  ) {
    const card = await this.prisma.nationCard.findFirst({
      where: {
        customer_id: requestCard.customer_id,
        status: NationCardStatus.ACTIVE,
      },
    });

    // Carte révoquée entre-temps → la révision devient une émission normale.
    if (!card) {
      return this.generateCard(requestCard, chosenLevel, chosenIsStudent);
    }

    const level: LoyaltyLevel | null =
      chosenLevel ?? requestCard.customer.loyalty_level ?? card.level ?? null;
    const isStudent =
      chosenIsStudent ?? requestCard.profile_type === ProfileType.ETUDIANT;
    const nickname = requestCard.nickname ?? card.nickname;

    const firstName = (requestCard.customer.first_name || '').split(' ')[0];
    const newImage = await this.cardGenerationService.generateCardImage(
      firstName,
      requestCard.customer.last_name || '',
      card.card_number,
      card.qr_code_value,
      nickname ?? undefined,
      { level, is_student: isStudent, photo_key: requestCard.photo },
    );

    const previousImage = card.card_image_url;
    const updated = await this.prisma.nationCard.update({
      where: { id: card.id },
      data: {
        level,
        is_student: isStudent,
        nickname,
        card_image_url: newImage,
        // La carte doit désormais pointer sur la demande de RÉVISION : c'est elle
        // qui porte la photo courante. Sans ça, une régénération ultérieure
        // relirait la photo de la demande d'origine (card_request.photo).
        card_request_id: requestCard.id,
      },
    });

    // Le profil suit le marqueur étudiant (audience des menus), comme à l'émission.
    await this.prisma.customer.update({
      where: { id: requestCard.customer_id },
      data: { profile_type: isStudent ? ProfileType.ETUDIANT : null },
    });

    if (previousImage && previousImage !== newImage) {
      await this.deleteS3Files([previousImage]);
    }

    return updated;
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
  async reviewRequest(
    id: string,
    userId: string,
    reviewDto: ReviewCardRequestDto,
    photoFile?: Express.Multer.File,
  ) {
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

    // Capturé AVANT la mise à jour : IN_REVIEW = demande de modif d'une carte
    // existante → à l'approbation on régénère, on n'émet pas une 2e carte.
    const wasRevision = request.status === CardRequestStatus.IN_REVIEW;

    // Mise à jour de la demande
    // Photo RECADRÉE par le staff au moment d'approuver (backoffice) : elle
    // remplace celle soumise par le client et devient la photo de la demande →
    // c'est elle que generateCard/applyRevision dessineront sur la carte.
    const recroppedPhoto = photoFile
      ? await this.uploadPhoto({ file: photoFile })
      : null;

    const updatedRequest = await this.prisma.cardRequest.update({
      where: { id },
      data: {
        status: reviewDto.status,
        rejection_reason: reviewDto.rejection_reason,
        reviewed_by: userId,
        reviewed_at: new Date(),
        ...(recroppedPhoto ? { photo: recroppedPhoto } : {}),
      },
      include: {
        customer: true,
      },
    });

    // Si approuvée : générer la carte + notifier. C'est le SEUL endroit d'où
    // part « carte prête » (push/cloche/WS + WhatsApp). Best-effort.
    if (reviewDto.status === CardRequestStatus.APPROVED) {
      // Une demande IN_REVIEW = révision d'une carte existante → on régénère
      // (numéro/QR conservés) au lieu d'émettre une 2e carte.
      const card = wasRevision
        ? await this.applyRevision(
            updatedRequest,
            reviewDto.level,
            reviewDto.is_student,
          )
        : await this.generateCard(
            updatedRequest,
            reviewDto.level,
            reviewDto.is_student,
          );

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

    // Temps réel : l'écran carte de l'app se resynchronise immédiatement
    // (APPROVED → la carte apparaît ; REJECTED → l'écran de refus).
    this.emitCardUpdated(updatedRequest.customer_id, `request_${reviewDto.status.toLowerCase()}`);


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
  private async generateCard(
    requestCard: any,
    chosenLevel?: LoyaltyLevel,
    chosenIsStudent?: boolean,
  ) {
    try {
      // DEUX AXES INDÉPENDANTS (cahier §4.5) : le niveau donne la COULEUR, le
      // marqueur étudiant se pose PAR-DESSUS (« Étudiant + VIP » possible).
      // Choix du staff prioritaire ; à défaut, dérivation auto depuis le client.
      const level: LoyaltyLevel | null =
        chosenLevel ?? requestCard.customer.loyalty_level ?? null;
      const isStudent =
        chosenIsStudent ?? requestCard.profile_type === ProfileType.ETUDIANT;

      const cardNumber = await this.allocateCardNumber();
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
        { level, is_student: isStudent, photo_key: requestCard.photo },
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
      // Le MARQUEUR étudiant retenu fait foi : émettre une carte avec le marqueur
      // ⇒ profil étudiant (et inversement), pour que visuel et menus concordent.
      await this.prisma.customer.update({
        where: { id: requestCard.customer_id },
        data: { profile_type: isStudent ? ProfileType.ETUDIANT : null },
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
   * Régénère le visuel d'une carte avec un TYPE imposé par le staff (backoffice).
   *
   * Diffère de `regenerateActiveCard` (automatique, pilotée par le niveau de
   * fidélité, clé = client) : ici c'est le staff qui choisit, la clé est la CARTE,
   * et on régénère même si le snapshot semble identique. Le numéro et le QR sont
   * conservés (identité inchangée) ; l'ancienne image est nettoyée de S3.
   * Le profil du client est aligné sur le type (carte étudiante ⇒ profil étudiant),
   * comme à l'approbation, pour que visuel et audience des menus restent cohérents.
   */
  async regenerateCard(id: string, level: LoyaltyLevel, isStudent = false) {
    const card = await this.prisma.nationCard.findUnique({
      where: { id },
      include: {
        customer: {
          select: { first_name: true, last_name: true, loyalty_level: true },
        },
        // La photo vit sur la DEMANDE → nécessaire pour la redessiner.
        card_request: { select: { photo: true } },
      },
    });

    if (!card) {
      throw new NotFoundException('Carte non trouvée');
    }

    const firstName = (card.customer.first_name || '').split(' ')[0];
    const newImage = await this.cardGenerationService.generateCardImage(
      firstName,
      card.customer.last_name || '',
      card.card_number,
      card.qr_code_value,
      card.nickname ?? undefined,
      { level, is_student: isStudent, photo_key: card.card_request?.photo },
    );

    const previousImage = card.card_image_url;
    const updated = await this.prisma.nationCard.update({
      where: { id },
      data: { level, is_student: isStudent, card_image_url: newImage },
    });

    await this.prisma.customer.update({
      where: { id: card.customer_id },
      data: { profile_type: isStudent ? ProfileType.ETUDIANT : null },
    });

    // L'ancien visuel n'est plus référencé → nettoyage best-effort.
    if (previousImage && previousImage !== newImage) {
      await this.deleteS3Files([previousImage]);
    }

    this.emitCardUpdated(updated.customer_id, 'card_regenerated');

    return {
      success: true,
      message: 'Carte régénérée avec succès',
      data: updated,
    };
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

    this.emitCardUpdated(updatedCard.customer_id, `card_${status.toLowerCase()}`);

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

    this.emitCardUpdated(request.customer_id, 'request_deleted');

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

    this.emitCardUpdated(card.customer_id, 'card_deleted');

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
  async previewCard(dto: PreviewCardDto, photoFile?: Express.Multer.File) {
    const isStudent = dto.is_student === true;

    const image = await this.cardGenerationService.generateCardImage(
      dto.first_name || 'Awa',
      dto.last_name || 'Koné',
      'CN-A7K29F',
      'APERCU-CARTE-NATION',
      dto.nickname || 'Jojo',
      {
        level: dto.level,
        is_student: isStudent,
        // Photo de test fournie par le backoffice ; sinon le champion par défaut.
        photo_buffer: photoFile?.buffer,
      },
      true,
    );

    return {
      success: true,
      data: { level: dto.level, is_student: isStudent, image },
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