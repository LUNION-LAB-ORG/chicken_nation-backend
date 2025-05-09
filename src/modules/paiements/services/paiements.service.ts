import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { EntityStatus, PaiementMobileMoneyType, PaiementMode, PaiementStatus } from '@prisma/client';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';

@Injectable()
export class PaiementsService {
  constructor(private readonly prisma: PrismaService) { }

  async create(createPaiementDto: CreatePaiementDto) {
    // Vérification de la commande
    const order = await this.verifyOrder(createPaiementDto);

    // Traitement du mode de paiement et du type de mobile money
    const { mode, mobile_money_type } = await this.verifyPaiementMode(createPaiementDto);

    // Traitement du statut du paiement
    const status = await this.verifyPaiementStatus(createPaiementDto);

    const paiement = await this.prisma.paiement.create({
      data: {
        ...createPaiementDto,
        order_id: order?.id,
        mode,
        status,
        mobile_money_type,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    if (order) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          paied_at: paiement.created_at,
          paied: true,
        },
      });
    }

    return paiement;
  }

  async findAll(queryDto: QueryPaiementDto) {
    const { page = 1, limit = 10, status = EntityStatus.ACTIVE, state = PaiementStatus.SUCCESS, order_id, search } = queryDto;
    const whereClause: any = { entity_status: EntityStatus.ACTIVE };

    if (status) {
      whereClause.entity_status = status;
    }

    if (state) {
      whereClause.status = state;
    }

    if (order_id) {
      whereClause.order_id = order_id;
    }
    if (search) {
      whereClause.OR = [
        { order_id: { contains: search, mode: 'insensitive' } },
        { mode: { contains: search, mode: 'insensitive' } },
        { state: { contains: search, mode: 'insensitive' } },
        { mobile_money_type: { contains: search, mode: 'insensitive' } },
      ];
    }

    const paiements = await this.prisma.paiement.findMany({
      where: whereClause,
      orderBy: {
        created_at: 'desc',
      },
      select: {
        id: true,
        amount: true,
        order_id: true,
        mode: true,
        mobile_money_type: true,
        status: true,
        reference: true,
        order: {
          select: {
            id: true,
            reference: true,
            customer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
      take: limit,
      skip: (page - 1) * limit,
    });
    return paiements;
  }

  findOne(paiementId: string) {
    const paiement = this.prisma.paiement.findUnique({
      where: {
        id: paiementId,
      },
    });
    if (!paiement) {
      throw new NotFoundException('Paiement non trouvé');
    }
    return paiement;
  }

  update(paiementId: string, updatePaiementDto: UpdatePaiementDto) {
    return this.prisma.paiement.update({
      where: {
        id: paiementId,
      },
      data: updatePaiementDto,
    });
  }

  remove(paiementId: string) {
    return this.prisma.paiement.delete({
      where: {
        id: paiementId,
      },
    });
  }

  private async verifyOrder(createPaiementDto: CreatePaiementDto) {
    const order = await this.prisma.order.findUnique({
      where: {
        id: createPaiementDto.order_id,
      },
    });
    if (!order) {
      return null;
    }

    if (createPaiementDto.amount < order.amount) {
      throw new BadRequestException('Le montant est inférieur au montant de la commande');
    }
    return order;
  }

  private async verifyPaiementMode(createPaiementDto: CreatePaiementDto) {
    // Vérification de l'existence du mode de paiement
    if (!createPaiementDto.mode) {
      throw new BadRequestException('Mode de paiement non fourni');
    }
    // Vérification de la validité du mode de paiement
    if (![PaiementMode.MOBILE_MONEY,
    PaiementMode.CREDIT_CARD,
    PaiementMode.CASH,
    PaiementMode.VIREMENT].includes(createPaiementDto.mode)) {
      throw new BadRequestException('Mode de paiement non valide');
    }

    // Si mode de paiement Mobile Money, alors vérification du type de mobile money
    if (createPaiementDto.mode === PaiementMode.MOBILE_MONEY) {
      // Vérification de l'existence du type de mobile money
      if (!createPaiementDto.mobile_money_type) {
        throw new BadRequestException('Type de mobile money non fourni');
      }
      // Vérification de la validité du type de mobile money
      if (![PaiementMobileMoneyType.ORANGE,
      PaiementMobileMoneyType.MTN,
      PaiementMobileMoneyType.MOOV,
      PaiementMobileMoneyType.WAVE].includes(createPaiementDto.mobile_money_type)) {
        throw new BadRequestException('Type de mobile money non valide');
      }
    }
    return { mode: createPaiementDto.mode, mobile_money_type: createPaiementDto.mobile_money_type ?? null };
  }

  private async verifyPaiementStatus(createPaiementDto: CreatePaiementDto) {
    // Vérification de l'existence du statut du paiement
    if (!createPaiementDto.status) {
      throw new BadRequestException('Statut du paiement non fourni');
    }

    // Vérification de la validité du statut du paiement
    if (![PaiementStatus.PENDING,
    PaiementStatus.SUCCESS,
    PaiementStatus.FAILED].includes(createPaiementDto.status)) {
      throw new BadRequestException('Statut du paiement non valide');
    }
    return createPaiementDto.status;
  }

}
