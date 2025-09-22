import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Customer, EntityStatus, Prisma } from '@prisma/client';
import { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { CustomerQueryDto } from '../dto/customer-query.dto';
import { CustomerEvent } from '../events/customer.event';

@Injectable()
export class CustomerService {
  constructor(private readonly prisma: PrismaService, private readonly customerEvent: CustomerEvent) { }

  async create(createCustomerDto: CreateCustomerDto) {
    // Vérifier si le client existe déjà avec ce numéro de téléphone
    const existingCustomer = await this.prisma.customer.findUnique({
      where: { phone: createCustomerDto.phone },
    });

    if (existingCustomer) {
      throw new ConflictException(`Utilisateur avec le numéro de téléphone ${createCustomerDto.phone} existe déjà`);
    }

    // Vérifier si l'email existe déjà (s'il est fourni)
    if (createCustomerDto.email) {
      const customerWithEmail = await this.prisma.customer.findUnique({
        where: { email: createCustomerDto.email },
      });

      if (customerWithEmail) {
        throw new ConflictException(`Utilisateur avec l'email ${createCustomerDto.email} existe déjà`);
      }
    }

    return this.prisma.customer.create({
      data: {
        ...createCustomerDto,
        entity_status: EntityStatus.NEW,
      },
    });
  }

  async findAll(query: CustomerQueryDto = {}): Promise<QueryResponseDto<Customer>> {
    const { page = 1, limit = 10, status, search } = query;
    const whereClause: Prisma.CustomerWhereInput = { entity_status: EntityStatus.ACTIVE };

    if (search) {
      whereClause.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (status) {
      whereClause.entity_status = status;
    }

    if (query.restaurantId) {
      whereClause.orders = {
        some: {
          restaurant_id: query.restaurantId,
        },
      };
    }

    const [count, customers] = await Promise.all([
      this.prisma.customer.count({ where: whereClause }),
      this.prisma.customer.findMany({
        where: whereClause,
        include: {
          addresses: {
            orderBy: {
              created_at: 'desc',
            },
          },
        },
        orderBy: {
          created_at: 'desc',
        },
        take: limit,
        skip: (page - 1) * limit,
      })]);

    return {
      data: customers,
      meta: {
        total: count,
        page: page,
        limit: limit,
        totalPages: Math.ceil(count / limit),
      },
    }
  }

  async detail(req: Request) {
    const customer = req.user as Customer;

    return await this.prisma.customer.findUnique({
      where: { id: customer.id },
      include: {
        addresses: true,
        favorites: {
          include: {
            dish: {
              include: {
                category: true,
              },
            },
          },
        },
        notification_settings: true,
      },
    });
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        addresses: true,
        favorites: {
          include: {
            dish: {
              include: {
                category: true,
              },
            },
          },
        },
        notification_settings: true,
      },
    });

    if (!customer || customer.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Utilisateur non trouvé`);
    }

    return customer;
  }

  async findByPhone(phone: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { phone },
      include: {
        addresses: true,
      },
    });

    if (!customer || customer.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Utilisateur au téléphone ${phone} est non trouvé`);
    }

    return customer;
  }

  async update(req: Request, updateCustomerDto: UpdateCustomerDto) {
    const id = (req.user as Customer).id;

    // Vérifier si le numéro de téléphone est unique
    if (updateCustomerDto.phone) {
      const existingCustomer = await this.prisma.customer.findUnique({
        where: { phone: updateCustomerDto.phone },
      });

      if (existingCustomer && existingCustomer.id !== id) {
        throw new ConflictException(`Utilisateur avec le numéro de téléphone ${updateCustomerDto.phone} existe déjà`);
      }
    }

    // Vérifier si l'email est unique
    if (updateCustomerDto.email) {
      const existingCustomer = await this.prisma.customer.findUnique({
        where: { email: updateCustomerDto.email },
      });

      if (existingCustomer && existingCustomer.id !== id) {
        throw new ConflictException(`Utilisateur avec l'email ${updateCustomerDto.email} existe déjà`);
      }
    }

    const existingCustomer = await this.prisma.customer.findUnique({
      where: { id },
    });

    const updatedCustomer = await this.prisma.customer.update({
      where: { id },
      data: {
        ...updateCustomerDto,
        entity_status: EntityStatus.ACTIVE,
      },
      include: {
        addresses: true,
      },
    });

    if (!existingCustomer?.first_name && !existingCustomer?.last_name && !existingCustomer?.email) {
      this.customerEvent.customerCreatedEvent({ customer: updatedCustomer });
    }

    return updatedCustomer;
  }

  async remove(id: string) {
    // Vérifier si le client existe
    const customer = await this.findOne(id);

    // Soft delete
    return this.prisma.customer.update({
      where: { id },
      data: {
        entity_status: EntityStatus.DELETED,
        phone: customer.phone + "D"
      },
    });
  }
}

