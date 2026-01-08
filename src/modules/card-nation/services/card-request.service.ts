import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CardRequestStatus, NationCardStatus, Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { CardRequestQueryDto, NationCardQueryDto } from '../dtos/card-query.dto';
import { CreateCardRequestDto } from '../dtos/create-card-request.dto';
import { ReviewCardRequestDto } from '../dtos/review-card-request.dto';
import { CardGenerationService } from './card-generation.service';
import { S3Service } from 'src/s3/s3.service';

@Injectable()
export class CardRequestService {

  constructor(
    private prisma: PrismaService,
    private cardGenerationService: CardGenerationService,
    private readonly s3service: S3Service
  ) { }

  /**
   * Créer une demande de carte (depuis l'app mobile)
   */
  async createRequest(customerId: string, createDto: CreateCardRequestDto, file: Express.Multer.File) {
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

    // Créer la demande

    // upload S3
    const result = await this.s3service.uploadFile({
      buffer: file.buffer,
      path: "chicken-nation/carte-etudiant",
      originalname: file.originalname,
      mimetype: file.mimetype
    })

    // creation
    const cardRequest = await this.prisma.cardRequest.create({
      data: {
        customer_id: customerId,
        nickname: createDto.nickname,
        institution: createDto.institution,
        student_card_file_url: result?.key ?? "",
        status: CardRequestStatus.PENDING,
      },
      include: {
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
          },
        },
      },
    });
    // mise à jour du client si date de naissance renseignée
    if (createDto.birth_day) {
      await this.prisma.customer.update({
        where: { id: customerId },
        data: {
          birth_day: createDto.birth_day,
        },
      });
    }

    return {
      success: true,
      message: 'Votre demande de carte Nation a été soumise avec succès',
      data: cardRequest,
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
   * Obtenir la carte Nation du client
   */
  async getMyCard(customerId: string) {
    const card = await this.prisma.nationCard.findFirst({
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
          },
        },
        card_request: {
          select: {
            institution: true,
            reviewed_at: true,
            created_at: true,
          },
        },
      },
    });

    if (!card) {
      throw new NotFoundException('Vous n\'avez pas encore de carte Nation active');
    }

    return card;
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

    // Si approuvée, générer la carte
    if (reviewDto.status === CardRequestStatus.APPROVED) {
      await this.generateCard(updatedRequest);
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
   * Génère une carte Nation après approbation
   */
  private async generateCard(request: any) {
    try {
      const cardNumber = this.cardGenerationService.generateCardNumber();
      const qrCodeValue = this.cardGenerationService.generateQRValue(
        cardNumber,
        request.customer_id,
      );

      const cardImagePath = await this.cardGenerationService.generateCardImage(
        request.customer.first_name || '',
        request.customer.last_name || '',
        cardNumber,
        qrCodeValue,
        request.nickname,
      );

      await this.prisma.nationCard.create({
        data: {
          customer_id: request.customer_id,
          card_request_id: request.id,
          nickname: request.nickname,
          card_number: cardNumber,
          qr_code_value: qrCodeValue,
          card_image_url: cardImagePath,
          status: NationCardStatus.ACTIVE,
        },
      });

    } catch (error) {
      throw new BadRequestException('Erreur lors de la génération de la carte');
    }
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
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            birth_day: true,
            image: true,
          },
        },
        card_request: {
          include: {
            customer: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
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