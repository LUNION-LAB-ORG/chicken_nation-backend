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
import * as ExcelJS from 'exceljs';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

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

  /**
   * Filtre des commandes « comptables » d'un client (payées, ou impayées mais
   * call center), hors supprimées. Réutilisé pour le compte, la dernière
   * commande et la dérivation de source à l'export.
   */
  private readonly accountableOrdersFilter: Prisma.OrderWhereInput = {
    OR: [{ AND: [{ paied: false }, { auto: false }] }, { paied: true }],
    entity_status: { not: EntityStatus.DELETED },
  };

  /**
   * Construit le `where` Prisma commun à la LISTE (findAll) et à l'EXPORT des
   * clients : recherche + statut + filtre restaurant + segment/onglet.
   * Centralisé pour que l'export reflète EXACTEMENT la liste affichée.
   */
  private buildWhereClause(query: CustomerQueryDto): Prisma.CustomerWhereInput {
    const { status, search, segment } = query;
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

    // Filtre restaurant : clients ayant au moins une commande dans ce resto.
    // (Surchargé/affiné ensuite par les segments has_ordered / never_ordered.)
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

    return whereClause;
  }

  async findAll(query: CustomerQueryDto = {}) {
    const { page = 1, limit = 10 } = query;
    const whereClause = this.buildWhereClause(query);
    // Compte total + dernière commande : scopés au restaurant si un filtre resto
    // est actif (cohérent avec l'export, et plus parlant : « N commandes dans CE
    // resto »). Sans filtre resto → comportement global inchangé.
    const ordersFilter: Prisma.OrderWhereInput = {
      ...this.accountableOrdersFilter,
      ...(query.restaurantId ? { restaurant_id: query.restaurantId } : {}),
    };

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
          // PERF : la liste n'affiche que le TOTAL de commandes et la date de la
          // dernière. On évitait de charger TOUTES les commandes de chaque client
          // (sans `take` → des centaines de lignes × 10 clients/page = très lourd).
          // → `_count` pour le total + `take: 1` pour la dernière. Le détail
          // (findOne) garde les commandes complètes.
          _count: {
            select: { orders: { where: ordersFilter } },
          },
          orders: {
            where: ordersFilter,
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { id: true, created_at: true },
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

  /**
   * Export Excel des clients filtrés — mêmes filtres que la liste (segment/onglet
   * + recherche + restaurant), donc l'export reflète exactement ce qui est à
   * l'écran. Colonnes : Nom, Prénom, Téléphone, Email, Date d'inscription,
   * Total commandes, Dernière commande, Source.
   *
   * La « Source » est dérivée de `order.auto` (true = Appli, false = Call center) :
   * Appli / Call center / Les deux. Elle est scopée au restaurant si un filtre
   * restaurant est appliqué (cohérent avec « clients ayant commandé dans ce resto »).
   */
  async exportCustomersToExcel(query: CustomerQueryDto) {
    const whereClause = this.buildWhereClause(query);

    // Commandes servant au total / à la dernière / à la source : « comptables »,
    // scopées au resto si filtré.
    const ordersFilter: Prisma.OrderWhereInput = {
      ...this.accountableOrdersFilter,
      ...(query.restaurantId ? { restaurant_id: query.restaurantId } : {}),
    };

    const customers = await this.prisma.customer.findMany({
      where: whereClause,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        phone: true,
        email: true,
        created_at: true,
        _count: { select: { orders: { where: ordersFilter } } },
        orders: {
          where: ordersFilter,
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { created_at: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 100000, // garde-fou anti-OOM (export ponctuel)
    });

    // Dérivation de la SOURCE par client : un seul groupBy (customer_id, auto).
    const ids = customers.map((c) => c.id);
    const sourceMap = new Map<string, { app: boolean; call: boolean }>();
    if (ids.length > 0) {
      const grouped = await this.prisma.order.groupBy({
        by: ['customer_id', 'auto'],
        where: { customer_id: { in: ids }, ...ordersFilter },
        _count: { _all: true },
      });
      for (const g of grouped) {
        if (!g.customer_id) continue;
        const cur = sourceMap.get(g.customer_id) ?? { app: false, call: false };
        if (g.auto) cur.app = true;
        else cur.call = true;
        sourceMap.set(g.customer_id, cur);
      }
    }

    const sourceLabel = (id: string, total: number): string => {
      if (total === 0) return '—';
      const s = sourceMap.get(id);
      if (!s) return '—';
      if (s.app && s.call) return 'Les deux';
      if (s.app) return 'Appli';
      if (s.call) return 'Call center';
      return '—';
    };

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Clients');
    worksheet.columns = [
      { header: 'Nom', key: 'last_name', width: 22 },
      { header: 'Prénom', key: 'first_name', width: 22 },
      { header: 'Téléphone', key: 'phone', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: "Date d'inscription", key: 'created_at', width: 20 },
      { header: 'Total commandes', key: 'total_orders', width: 16 },
      { header: 'Dernière commande', key: 'last_order', width: 20 },
      { header: 'Source', key: 'source', width: 14 },
    ];

    customers.forEach((c) => {
      const total = c._count?.orders ?? 0;
      worksheet.addRow({
        last_name: c.last_name || '',
        first_name: c.first_name || '',
        phone: c.phone || '',
        email: c.email || '',
        created_at: format(new Date(c.created_at), 'dd/MM/yyyy HH:mm', { locale: fr }),
        total_orders: total,
        last_order: c.orders[0]?.created_at
          ? format(new Date(c.orders[0].created_at), 'dd/MM/yyyy HH:mm', { locale: fr })
          : '—',
        source: sourceLabel(c.id, total),
      });
    });

    // En-tête stylée (orange marque)
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF17922' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getColumn('total_orders').alignment = { horizontal: 'center' };
    worksheet.getColumn('source').alignment = { horizontal: 'center' };

    // Bordures fines + alternance de lignes
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });
      if (rowNumber > 1 && rowNumber % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return {
      buffer,
      filename: `clients-${new Date().toISOString().split('T')[0]}.xlsx`,
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
