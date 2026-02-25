import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, User, VoucherStatus } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { QueryVoucherDto } from './dto/query-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { VoucherResponseDto } from './dto/voucher-response.dto';
import { RedeemVoucherDto } from './dto/redeem-voucher.dto';
import { RedemptionResponseDto } from './dto/redemption-response.dto';
import { Cron, CronExpression } from '@nestjs/schedule';

const voucherInclude = {
  customer: {
    select: {
      id: true,
      email: true,
      first_name: true,
      last_name: true,
      phone: true,
    }
  },
  creator: {
    select: {
      id: true,
      email: true,
      fullname: true,
    }
  },
}

type VoucherWithRelations = Prisma.VoucherGetPayload<{
  include: typeof voucherInclude
}>;

@Injectable()
export class VoucherService {
  private readonly logger = new Logger(VoucherService.name);
  constructor(
    private readonly prismaService: PrismaService,
  ) { }

  private readonly include = voucherInclude;

  async create(req: Request, createVoucherDto: CreateVoucherDto) {
    const userId = (req.user as User).id;

    this.logger.log({
      message: 'Voucher creation initiated',
      amount: createVoucherDto.initialAmount,
      expiryDate: createVoucherDto.expiresAt,
    });

    this.logger.debug({
      message: 'Request details',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      data: createVoucherDto,
    });

    const { initialAmount, customerId, expiresAt = null } = createVoucherDto;

    // Validation: montant initial doit être positif
    if (initialAmount <= 0) {
      throw new HttpException('Le montant initial doit être supérieur à 0', HttpStatus.BAD_REQUEST);
    }

    // Validation: date d'expiration ne peut pas être dans le passé
    if (expiresAt && new Date(expiresAt) < new Date()) {
      throw new HttpException('La date d\'expiration ne peut pas être dans le passé', HttpStatus.BAD_REQUEST);
    }

    const voucher = await this.prismaService.voucher.create({
      data: {
        initial_amount: initialAmount,
        remaining_amount: initialAmount,
        customer_id: customerId,
        expires_at: expiresAt,
        code: this.generateVoucherCode(),
        created_by: userId,
      },
      include: this.include,
    });

    this.logger.log({
      message: 'Voucher successfully created',
      userId,
      amount: createVoucherDto.initialAmount,
      expiryDate: createVoucherDto.expiresAt,
    });

    return this.mapToDto(voucher);
  }

  async findAll(filter: QueryVoucherDto) {
    const { page, limit = 20, sortBy = 'created_at', sortOrder = 'desc', ...rest } = filter;
    const skip = page && limit ? (page - 1) * limit : undefined;

    this.logger.log({
      message: 'Fetching all vouchers with filters',
      filters: rest,
      page,
      limit,
      sortBy,
      sortOrder,
    });

    const vouchers = await this.prismaService.voucher.findMany({
      include: this.include,
      where: {
        entity_status: { not: 'DELETED' },
        ...(rest.customerId && { customer_id: rest.customerId }),
        ...(rest.minInitialAmount && { initial_amount: { gte: rest.minInitialAmount } }),
        ...(rest.maxInitialAmount && { initial_amount: { lte: rest.maxInitialAmount } }),
        ...(rest.minRemainingAmount && { remaining_amount: { gte: rest.minRemainingAmount } }),
        ...(rest.maxRemainingAmount && { remaining_amount: { lte: rest.maxRemainingAmount } }),
        ...(rest.minExpiresAt && { expires_at: { gte: rest.minExpiresAt } }),
        ...(rest.maxExpiresAt && { expires_at: { lte: rest.maxExpiresAt } }),
      },
      orderBy: { [sortBy]: sortOrder },
      ...(page && limit ? { skip, take: limit } : {}),
    });

    this.logger.log({
      message: 'Fetched all vouchers',
      count: vouchers.length,
    });

    return vouchers.map(voucher => this.mapToDto(voucher));
  }

  async findOne(code: string) {
    this.logger.log({ message: `Fetching voucher with code: ${code}` });
    const voucher = await this.prismaService.voucher.findUnique({
      where: { code },
      include: this.include,
    });
    return voucher ? this.mapToDto(voucher) : null;
  }

  async update(code: string, updateVoucherDto: UpdateVoucherDto) {
    this.logger.log({ message: `Updating voucher with code: ${code}`, updates: updateVoucherDto });

    const { initialAmount, customerId, expiresAt, ...rest } = updateVoucherDto;

    // On ne peut pas mettre à jour un voucher qui a été REDEEMED ou qui est EXPIRED
    const voucher = await this.prismaService.voucher.findFirst({
      where: {
        code,
        status: {
          in: [VoucherStatus.ACTIVE, VoucherStatus.CANCELLED],
        }
      },
      include: this.include,
    });

    if (!voucher) {
      this.logger.warn({ message: `Voucher with code ${code} not found for update` });
      return null;
    }

    // Si le montant restant est supérieur au montant à mettre à jour on renvoie une erreur 400
    if (initialAmount !== undefined && voucher.remaining_amount > initialAmount) {
      this.logger.warn({
        message: `Cannot update voucher ${code}: remaining amount ${voucher.remaining_amount} exceeds new initial amount ${initialAmount}`,
      });
      throw new HttpException(`Le montant restant ${voucher.remaining_amount} est supérieur au nouveau montant initial ${initialAmount}`, HttpStatus.BAD_REQUEST);
    }

    // Validation: date d'expiration ne peut pas être dans le passé
    if (expiresAt && new Date(expiresAt) < new Date()) {
      throw new HttpException('La date d\'expiration ne peut pas être dans le passé', HttpStatus.BAD_REQUEST);
    }

    const updatedVoucher = await this.prismaService.voucher.update({
      where: { code },
      data: {
        ...(initialAmount !== undefined && { initial_amount: initialAmount }),
        ...(customerId !== undefined && { customer_id: customerId }),
        ...(expiresAt !== undefined && { expires_at: expiresAt }),
        ...rest,
      },
      include: this.include,
    });

    return this.mapToDto(updatedVoucher);
  }

  async remove(code: string): Promise<boolean> {
    this.logger.log({ message: `Soft deleting voucher with code: ${code}` });
    const result = await this.prismaService.voucher.update({
      where: { code },
      data: {
        entity_status: 'DELETED',
      },
    });

    this.logger.log({ message: `Voucher with code ${code} soft deleted` });
    this.logger.debug({ message: 'Soft delete result', result });

    return result !== null;
  }

  async restore(code: string): Promise<VoucherResponseDto | null> {
    this.logger.log({ message: `Restoring voucher with code: ${code}` });
    const result = await this.prismaService.voucher.update({
      where: { code },
      data: {
        entity_status: 'ACTIVE',
      },
      include: this.include,
    });
    this.logger.log({ message: `Voucher with code ${code} restored` });
    this.logger.debug({ message: 'Restore result', result });

    return this.mapToDto(result);
  }

  async cancel(code: string): Promise<VoucherResponseDto | null> {
    this.logger.log({ message: `Cancelling voucher with code: ${code}` });
    
    const voucher = await this.prismaService.voucher.findUnique({
      where: { code },
      include: this.include,
    });

    if (!voucher) {
      throw new HttpException('Voucher non trouvé', HttpStatus.NOT_FOUND);
    }

    // On ne peut annuler que les vouchers ACTIVE
    if (voucher.status !== VoucherStatus.ACTIVE) {
      throw new HttpException(
        `Impossible d'annuler un voucher avec le statut ${voucher.status}`,
        HttpStatus.BAD_REQUEST
      );
    }

    const cancelledVoucher = await this.prismaService.voucher.update({
      where: { code },
      data: {
        status: VoucherStatus.CANCELLED,
      },
      include: this.include,
    });

    this.logger.log({ message: `Voucher ${code} cancelled successfully` });
    return this.mapToDto(cancelledVoucher);
  }

  async redeemVoucher(code: string, customerId: string, redeemDto: RedeemVoucherDto): Promise<RedemptionResponseDto> {
    this.logger.log({ 
      message: `Redeeming voucher ${code}`, 
      customerId, 
      amount: redeemDto.amount 
    });

    const { orderId, amount } = redeemDto;

    // Validation du montant
    if (amount <= 0) {
      throw new HttpException('Le montant doit être supérieur à 0', HttpStatus.BAD_REQUEST);
    }

    return await this.prismaService.$transaction(async (prisma) => {
      // Récupérer le voucher avec un verrou
      const voucher = await prisma.voucher.findUnique({
        where: { code },
        include: this.include,
      });

      if (!voucher) {
        throw new HttpException('Voucher non trouvé', HttpStatus.NOT_FOUND);
      }

      // Vérifier que le voucher appartient au client
      if (voucher.customer_id !== customerId) {
        throw new HttpException('Ce voucher ne vous appartient pas', HttpStatus.FORBIDDEN);
      }

      // Vérifier le statut
      if (voucher.status !== VoucherStatus.ACTIVE) {
        throw new HttpException(
          `Ce voucher ne peut pas être utilisé (statut: ${voucher.status})`,
          HttpStatus.BAD_REQUEST
        );
      }

      // Vérifier l'expiration
      if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
        // Mettre à jour le statut en EXPIRED
        await prisma.voucher.update({
          where: { code },
          data: { status: VoucherStatus.EXPIRED },
        });
        throw new HttpException('Ce voucher a expiré', HttpStatus.BAD_REQUEST);
      }

      // Vérifier le montant disponible
      if (voucher.remaining_amount < amount) {
        throw new HttpException(
          `Montant insuffisant. Disponible: ${voucher.remaining_amount}`,
          HttpStatus.BAD_REQUEST
        );
      }

      // Calculer le nouveau montant restant
      const newRemainingAmount = voucher.remaining_amount - amount;
      const isFullyRedeemed = newRemainingAmount === 0;

      // Créer la rédemption
      const redemption = await prisma.redemption.create({
        data: {
          voucher_id: voucher.id,
          order_id: orderId,
          amount: amount,
        },
      });

      // Mettre à jour le voucher
      const updatedVoucher = await prisma.voucher.update({
        where: { code },
        data: {
          remaining_amount: newRemainingAmount,
          ...(isFullyRedeemed && {
            status: VoucherStatus.REDEEMED,
            redeemed_at: new Date(),
          }),
        },
        include: this.include,
      });

      this.logger.log({
        message: 'Voucher redeemed successfully',
        code,
        amount,
        remainingAmount: newRemainingAmount,
        fullyRedeemed: isFullyRedeemed,
      });

      return {
        redemption: {
          id: redemption.id,
          amount: redemption.amount,
          orderId: redemption.order_id,
          createdAt: redemption.created_at,
        },
        voucher: this.mapToDto(updatedVoucher),
      };
    });
  }

  async getRedemptionHistory(code: string): Promise<any[]> {
    this.logger.log({ message: `Fetching redemption history for voucher: ${code}` });

    const voucher = await this.prismaService.voucher.findUnique({
      where: { code },
      include: {
        Redemption: {
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!voucher) {
      throw new HttpException('Voucher non trouvé', HttpStatus.NOT_FOUND);
    }

    return voucher.Redemption.map(redemption => ({
      id: redemption.id,
      amount: redemption.amount,
      orderId: redemption.order_id,
      createdAt: redemption.created_at,
    }));
  }

  async getCustomerRedemptions(customerId: string): Promise<any[]> {
    this.logger.log({ message: `Fetching redemptions for customer: ${customerId}` });

    const redemptions = await this.prismaService.redemption.findMany({
      where: {
        voucher: {
          customer_id: customerId,
        },
      },
      include: {
        voucher: {
          select: {
            code: true,
            initial_amount: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return redemptions.map(redemption => ({
      id: redemption.id,
      amount: redemption.amount,
      orderId: redemption.order_id,
      voucherCode: redemption.voucher.code,
      voucherInitialAmount: redemption.voucher.initial_amount,
      createdAt: redemption.created_at,
    }));
  }

  // Cron job pour mettre à jour les vouchers expirés (tous les jours à minuit)
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async updateExpiredVouchers() {
    this.logger.log('Running cron job to update expired vouchers');

    const result = await this.prismaService.voucher.updateMany({
      where: {
        status: VoucherStatus.ACTIVE,
        expires_at: {
          lt: new Date(),
        },
      },
      data: {
        status: VoucherStatus.EXPIRED,
      },
    });

    this.logger.log(`Updated ${result.count} expired vouchers`);
  }

  private generateVoucherCode(): string {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const random = Math.floor(100 + Math.random() * 900);
    return `CNV-${year}${month}${day}-${random}`;
  }

  private mapToDto(voucher: VoucherWithRelations): VoucherResponseDto {
    return {
      id: voucher.id,
      code: voucher.code,
      initialAmount: voucher.initial_amount,
      remainingAmount: voucher.remaining_amount,
      customer: {
        id: voucher.customer.id,
        email: voucher.customer.email,
        firstName: voucher.customer.first_name,
        lastName: voucher.customer.last_name,
        phone: voucher.customer.phone,
      },
      expiresAt: voucher.expires_at,
      createdBy: {
        id: voucher.creator.id,
        email: voucher.creator.email,
        fullName: voucher.creator.fullname,
      },
      createdAt: voucher.created_at,
      updatedAt: voucher.updated_at,
      status: voucher.status,
      entityStatus: voucher.entity_status,
    };
  }
}