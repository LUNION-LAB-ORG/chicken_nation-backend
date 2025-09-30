import { PrismaService } from './../../database/services/prisma.service';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { Request } from 'express';
import { Prisma, User, Voucher, VoucherStatus } from '@prisma/client';
import { VoucherResponseDto } from './dto/voucher-response.dto';
import { QueryVoucherDto } from './dto/query-voucher.dto';

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

    // On ne peut pas mettre a jour un voucher qui a ete REEDEMED ou qui est EXPIRED
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

    // Si le montant restant est superieur au montant a mettre a jour on renvoie une erreur 400
    if (initialAmount !== undefined && voucher.remaining_amount > initialAmount) {
      this.logger.warn({
        message: `Cannot update voucher ${code}: remaining amount ${voucher.remaining_amount} exceeds new initial amount ${initialAmount}`,
      });
      throw new HttpException(`Le montant restant ${voucher.remaining_amount} est supérieur au nouveau montant initial ${initialAmount}`, HttpStatus.BAD_REQUEST);
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

  private generateVoucherCode(): string {
    return "CHICKEN-" + Math.random().toString(36).substring(2, 12).toUpperCase();
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
