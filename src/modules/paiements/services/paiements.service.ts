import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { Customer, EntityStatus, PaiementMode, PaiementStatus } from '@prisma/client';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { CreatePaiementKkiapayDto } from 'src/modules/paiements/dto/create-paiement-kkiapay.dto';
import { Request } from 'express';
import { PaiementEvent } from 'src/modules/paiements/events/paiement.event';

@Injectable()
export class PaiementsService {
  constructor(private readonly prisma: PrismaService, private readonly kkiapay: KkiapayService, private readonly paiementEvent: PaiementEvent) { }

  // Payer avec Kkiapay
  async payWithKkiapay(req: Request, createPaiementKkiapayDto: CreatePaiementKkiapayDto) {

    const transaction = await this.kkiapay.verifyTransaction(createPaiementKkiapayDto.transactionId);

    const customer = req.user as Customer;

    const paiement = await this.create({
      reference: transaction.transactionId,
      amount: transaction.amount,
      fees: transaction.fees,
      total: transaction.amount + transaction.fees,
      mode: transaction.source,
      source: transaction.source_common_name,
      client: typeof transaction.client === 'object' ? JSON.stringify(transaction.client) : transaction.client,
      status: transaction.status,
      failure_code: transaction.failureCode,
      failure_message: transaction.failureMessage,
      order_id: createPaiementKkiapayDto?.orderId,
      client_id: customer.id,
    });

    return {
      success: transaction.status === "SUCCESS",
      message: transaction.status === "SUCCESS" ? 'Paiement effectué avec succès' : 'Paiement echoué',
      transactionId: transaction.transactionId,
      paiement: paiement,
    };
  }

  // Récupération des paiements succès libres
  async getFreePaiements(req: Request) {
    const customer = req.user as Customer;
    let paiements = await this.prisma.paiement.findMany({
      where: {
        status: PaiementStatus.SUCCESS,
        order_id: null,
        client_id: customer.id,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    if (paiements.length === 0) {
      paiements = paiements.filter((p) => {
        const client = JSON.parse(typeof p?.client == "string" ? p.client : "{}");
        return (client?.email?.trim()?.toLowerCase() === customer.email?.trim()?.toLowerCase() ||
          client?.phone?.trim()?.toLowerCase().includes(customer.phone?.trim()?.toLowerCase())
          || customer?.phone?.trim()?.toLowerCase().includes(client?.phone?.trim()?.toLowerCase()));
      });
    }

    return paiements;
  }

  // Remboursement d'un paiement par Kkiapay
  async refundPaiement(paiementId: string) {
    const paiement = await this.findOne(paiementId);

    if (paiement.status !== PaiementStatus.SUCCESS) {
      throw new BadRequestException('Le paiement n\'est pas en cours');
    }

    const transaction = await this.kkiapay.refundTransaction(paiement.reference);

    const updatedPaiement = await this.update(paiementId, {
      status: PaiementStatus.REVERTED,
      failure_code: transaction.failureCode,
      failure_message: transaction.failureMessage,
    });

    // Émission de l'événement de paiement annulé
    this.paiementEvent.paiementAnnule(paiement);

    return {
      success: updatedPaiement.status === "REVERTED",
      message: updatedPaiement.status === "REVERTED" ? 'Remboursement effectué avec succès' : 'Remboursement echoué',
      transactionId: updatedPaiement.reference,
      paiement: updatedPaiement,
    };
  }

  // Création de paiement
  async create(createPaiementDto: CreatePaiementDto) {
    // Vérification de la commande
    const order = await this.verifyOrder(createPaiementDto.amount, createPaiementDto.order_id ?? null);

    // Traitement du mode de paiement et du type de mobile money
    const { mode, source } = await this.verifyPaiementMode(createPaiementDto.mode, createPaiementDto.source ?? null);

    // Traitement du statut du paiement
    const status = await this.verifyPaiementStatus(createPaiementDto.status);

    const paiement = await this.prisma.paiement.create({
      data: {
        ...createPaiementDto,
        order_id: order?.id ?? null,
        mode,
        status,
        source,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    // Mise a jour de la commande à payée
    if (order) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          paied_at: paiement.created_at,
          paied: true,
        },
      });
    }

    // Émission de l'événement de paiement effectué
    this.paiementEvent.paiementEffectue(paiement);

    return paiement;
  }

  // Récupération de tous les paiements
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
        { source: { contains: search, mode: 'insensitive' } },
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
        source: true,
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

  // Récupération d'un paiement
  async findOne(paiementId: string) {
    const paiement = await this.prisma.paiement.findUnique({
      where: {
        id: paiementId,
      },
    });
    if (!paiement) {
      throw new NotFoundException('Paiement non trouvé');
    }
    return paiement;
  }

  // Mise à jour d'un paiement
  async update(paiementId: string, updatePaiementDto: UpdatePaiementDto) {
    const paiement = await this.findOne(paiementId);

    // Vérification de la commande
    const order = await this.verifyOrder(updatePaiementDto.amount ?? paiement.amount, updatePaiementDto.order_id ?? paiement.order_id);

    // Traitement du mode de paiement et du type de mobile money
    const { mode, source } = await this.verifyPaiementMode(updatePaiementDto.mode ?? paiement.mode, updatePaiementDto.source ?? paiement.source);

    // Traitement du statut du paiement
    const status = await this.verifyPaiementStatus(updatePaiementDto.status ?? paiement.status);

    return this.prisma.paiement.update({
      where: {
        id: paiement.id,
      },
      data: {
        ...updatePaiementDto,
        order_id: order?.id,
        mode,
        status,
        source,
      },
    });
  }

  // Suppression d'un paiement
  async remove(paiementId: string) {
    const paiement = await this.findOne(paiementId);
    return this.prisma.paiement.delete({
      where: {
        id: paiement.id,
      },
    });
  }

  // Vérification de la commande
  private async verifyOrder(amount: number, order_id: string | null) {
    if (!order_id) {
      return null;
    }
    const order = await this.prisma.order.findUnique({
      where: {
        id: order_id,
      },
    });
    if (!order) {
      return null;
    }

    if (amount < order.amount) {
      throw new BadRequestException('Le montant est inférieur au montant de la commande');
    }
    return order;
  }

  // Vérification du mode de paiement
  private async verifyPaiementMode(mode: PaiementMode, source: string | null) {
    // Vérification de l'existence du mode de paiement
    if (!mode) {
      throw new BadRequestException('Mode de paiement non fourni');
    }
    // Vérification de la validité du mode de paiement
    if (![PaiementMode.MOBILE_MONEY,
    PaiementMode.WALLET,
    PaiementMode.CREDIT_CARD,
    PaiementMode.CASH].includes(mode)) {
      throw new BadRequestException('Mode de paiement non valide');
    }

    return { mode, source };
  }

  // Vérification du statut du paiement
  private async verifyPaiementStatus(status: PaiementStatus) {
    // Vérification de l'existence du statut du paiement
    if (!status) {
      throw new BadRequestException('Statut du paiement non fourni');
    }

    // Vérification de la validité du statut du paiement
    if (![PaiementStatus.REVERTED,
    PaiementStatus.SUCCESS,
    PaiementStatus.FAILED].includes(status)) {
      throw new BadRequestException('Statut du paiement non valide');
    }
    return status;
  }
}
