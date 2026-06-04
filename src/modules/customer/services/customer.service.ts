import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Customer, EntityStatus, Prisma } from '@prisma/client';
import type { Request } from 'express';
import * as fs from 'fs';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { AdminUpdateCustomerDto } from 'src/modules/customer/dto/admin-update-customer.dto';
import { CustomerQueryDto } from '../dto/customer-query.dto';
import { CustomerEvent } from '../events/customer.event';
import { S3Service } from '../../../s3/s3.service';

@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerEvent: CustomerEvent,
    private readonly s3service: S3Service,
  ) { }

  private async safeUpdate(customer: Customer, data: CreateCustomerDto) {
    if (!customer.email && data.email) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          email: data.email,
        },
      });
    }
    if (!customer.first_name && data.first_name) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          first_name: data.first_name,
        },
      });
    }
    if (!customer.last_name && data.last_name) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          last_name: data.last_name,
        },
      });
    }
  }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image) return null;
    const buffer = image.buffer ?? fs.readFileSync(image.path);
    return this.s3service.uploadFile({
      buffer,
      path: 'chicken-nation/customer-avatar',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  async create(
    createCustomerDto: CreateCustomerDto,
    image?: Express.Multer.File,
  ) {
    // Vérifier si le client existe déjà avec ce numéro de téléphone
    const existingCustomer = await this.prisma.customer.findUnique({
      where: { phone: createCustomerDto.phone },
    });

    if (existingCustomer) {
      this.safeUpdate(existingCustomer, createCustomerDto);
      throw new ConflictException(
        `Utilisateur avec le numéro de téléphone ${createCustomerDto.phone} existe déjà`,
      );
    }

    // Vérifier si l'email existe déjà (s'il est fourni)
    if (createCustomerDto.email) {
      const customerWithEmail = await this.prisma.customer.findUnique({
        where: { email: createCustomerDto.email },
      });

      if (customerWithEmail) {
        this.safeUpdate(customerWithEmail, createCustomerDto);
        throw new ConflictException(
          `Utilisateur avec l'email ${createCustomerDto.email} existe déjà`,
        );
      }
    }

    // upload image
    const uploadResult = await this.uploadImage(image);

    // create customer
    const customer = await this.prisma.customer.create({
      data: {
        ...createCustomerDto,
        entity_status: EntityStatus.ACTIVE,
        image: uploadResult?.key ?? createCustomerDto.image,
      },
    });

    // Créer ses paramètres de notifications
    await this.prisma.notificationSetting.create({
      data: {
        customer_id: customer.id,
      },
    });

    // emit event
    this.customerEvent.customerCreatedEvent({ customer });

    return customer;
  }

  async findAll(query: CustomerQueryDto = {}) {
    const { page = 1, limit = 10, status, search, segment } = query;
    const whereClause: Prisma.CustomerWhereInput = {
      entity_status: EntityStatus.ACTIVE,
    };

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

    // ── Segment filters ──
    if (segment && segment !== 'all') {
      switch (segment) {
        case 'app_users':
          whereClause.notification_settings = {
            expo_push_token: { not: null },
            active: true,
          };
          break;
        case 'no_app':
          whereClause.OR = undefined; // reset search OR to use AND
          whereClause.AND = [
            // Re-add search if present
            ...(search
              ? [{
                  OR: [
                    { first_name: { contains: search, mode: 'insensitive' as const } },
                    { last_name: { contains: search, mode: 'insensitive' as const } },
                    { phone: { contains: search } },
                    { email: { contains: search, mode: 'insensitive' as const } },
                  ],
                }]
              : []),
            {
              OR: [
                { notification_settings: null },
                { notification_settings: { expo_push_token: null } },
              ],
            },
          ];
          break;
        case 'has_ordered':
          whereClause.orders = {
            some: {
              entity_status: { not: EntityStatus.DELETED },
              ...(query.restaurantId ? { restaurant_id: query.restaurantId } : {}),
            },
          };
          break;
        case 'never_ordered':
          whereClause.orders = {
            none: {
              entity_status: { not: EntityStatus.DELETED },
            },
          };
          break;
        case 'incomplete_profile':
          whereClause.OR = undefined;
          whereClause.AND = [
            ...(search
              ? [{
                  OR: [
                    { first_name: { contains: search, mode: 'insensitive' as const } },
                    { last_name: { contains: search, mode: 'insensitive' as const } },
                    { phone: { contains: search } },
                    { email: { contains: search, mode: 'insensitive' as const } },
                  ],
                }]
              : []),
            {
              OR: [
                { first_name: null },
                { first_name: '' },
                { last_name: null },
                { last_name: '' },
              ],
            },
          ];
          break;
      }
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
          notification_settings: {
            select: { expo_push_token: true, active: true },
          },
          orders: {
            where: {
              OR: [
                {
                  AND: [{ paied: false }, { auto: false }],
                },
                {
                  paied: true,
                },
              ],
              entity_status: { not: EntityStatus.DELETED },
            },
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
      }),
    ]);

    return {
      data: customers,
      meta: {
        total: count,
        page: page,
        limit: limit,
        totalPages: Math.ceil(count / limit),
      },
    };
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
        addresses: {
          orderBy: {
            created_at: 'desc',
          },
        },
        favorites: {
          orderBy: {
            created_at: 'desc',
          },
          include: {
            dish: {
              include: {
                category: true,
              },
            },
          },
        },
        orders: {
          where: {
            OR: [
              {
                AND: [{ paied: false }, { auto: false }],
              },
              {
                paied: true,
              },
            ],
            entity_status: { not: EntityStatus.DELETED },
          },
          orderBy: {
            created_at: 'desc',
          },
        },
        notification_settings: true,
        loyalty_points: {
          orderBy: {
            created_at: 'desc',
          },
        },
        promotion_usages: {
          orderBy: {
            created_at: 'desc',
          },
        },
        loyalty_level_history: {
          orderBy: {
            created_at: 'desc',
          },
        },
        Comment: {
          orderBy: {
            created_at: 'desc',
          },
        },
        TicketMessage: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        Message: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        TicketThread: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        Conversation: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        cardRequests: {
          orderBy: {
            created_at: 'desc',
          },
        },
        nationCards: {
          orderBy: {
            created_at: 'desc',
          },
        },
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
      throw new NotFoundException(
        `Utilisateur au téléphone ${phone} est non trouvé`,
      );
    }

    return customer;
  }

  async update(
    req: Request,
    updateCustomerDto: UpdateCustomerDto,
    image?: Express.Multer.File,
  ) {
    const id = (req.user as Customer).id;

    // Vérifier si le numéro de téléphone est unique
    if (updateCustomerDto.phone) {
      const existingCustomer = await this.prisma.customer.findUnique({
        where: { phone: updateCustomerDto.phone },
      });

      if (existingCustomer && existingCustomer.id !== id) {
        throw new ConflictException(
          `Utilisateur avec le numéro de téléphone ${updateCustomerDto.phone} existe déjà`,
        );
      }
    }

    // Vérifier si l'email est unique
    if (updateCustomerDto.email) {
      const existingCustomer = await this.prisma.customer.findUnique({
        where: { email: updateCustomerDto.email },
      });

      if (existingCustomer && existingCustomer.id !== id) {
        throw new ConflictException(
          `Utilisateur avec l'email ${updateCustomerDto.email} existe déjà`,
        );
      }
    }

    const existingCustomer = await this.prisma.customer.findUnique({
      where: { id },
    });

    const uploadResult = await this.uploadImage(image);

    const updatedCustomer = await this.prisma.customer.update({
      where: { id },
      data: {
        ...updateCustomerDto,
        entity_status: EntityStatus.ACTIVE,
        image: uploadResult?.key ?? updateCustomerDto.image,
      },
      include: {
        addresses: true,
      },
    });

    if (
      !existingCustomer?.first_name &&
      !existingCustomer?.last_name &&
      !existingCustomer?.email
    ) {
      this.customerEvent.customerCreatedEvent({ customer: updatedCustomer });
    }

    // Créer ses paramètres de notifications
    const exite_notificationSetting = await this.prisma.notificationSetting.findFirst({
      where: { customer_id: id }
    })
    if (!exite_notificationSetting) {
      await this.prisma.notificationSetting.create({
        data: {
          customer_id: id,
        },
      });
    }

    return updatedCustomer;
  }

  /**
   * Modification des infos d'identité d'un client par un agent BACKOFFICE.
   * Met à jour uniquement prénom / nom / email / téléphone. Vérifie l'existence
   * du client puis l'unicité du téléphone et de l'email (en excluant le client
   * courant). N'altère ni l'image, ni les paramètres de notification.
   */
  async adminUpdate(id: string, dto: AdminUpdateCustomerDto) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      throw new NotFoundException('Client introuvable');
    }

    // Unicité du téléphone (hors client courant)
    if (dto.phone && dto.phone !== customer.phone) {
      const existing = await this.prisma.customer.findUnique({
        where: { phone: dto.phone },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Un client avec le numéro de téléphone ${dto.phone} existe déjà`,
        );
      }
    }

    // Unicité de l'email (hors client courant)
    if (dto.email && dto.email !== customer.email) {
      const existing = await this.prisma.customer.findUnique({
        where: { email: dto.email },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Un client avec l'email ${dto.email} existe déjà`,
        );
      }
    }

    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.first_name !== undefined && { first_name: dto.first_name }),
        ...(dto.last_name !== undefined && { last_name: dto.last_name }),
        ...(dto.email !== undefined && { email: dto.email }),
      },
      include: { addresses: true },
    });
  }

  async remove(id: string) {
    // Vérifier si le client existe
    const customer = await this.findOne(id);

    // Soft delete
    const deletedCustomer = await this.prisma.customer.update({
      where: { id },
      data: {
        entity_status: EntityStatus.DELETED,
        phone: customer.phone + 'D',
      },
    });

    // Créer ses paramètres de notifications
    const exite_notificationSetting = await this.prisma.notificationSetting.findFirst({
      where: { customer_id: id }
    })
    if (!exite_notificationSetting) {
      await this.prisma.notificationSetting.update({
        where: { customer_id: id },
        data: {
          active: false,
        },
      });
    }

    return deletedCustomer;
  }
}
