import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';

@Injectable()
export class AddressService {
  constructor(private prisma: PrismaService) { }

  async create(createAddressDto: CreateAddressDto) {
    // Si un customer_id est fourni, vérifier que le client existe
    if (createAddressDto.customer_id) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: createAddressDto.customer_id },
      });

      if (!customer || customer.entity_status !== EntityStatus.ACTIVE) {
        throw new NotFoundException(`Customer with ID ${createAddressDto.customer_id} not found`);
      }
    }

    return this.prisma.address.create({
      data: {
        ...createAddressDto,
        entity_status: EntityStatus.ACTIVE,
      },
    });
  }

  async findAll() {
    return this.prisma.address.findMany({
      where: { entity_status: EntityStatus.ACTIVE },
      include: {
        customer: true,
      },
      orderBy: {
        created_at: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const address = await this.prisma.address.findUnique({
      where: { id },
      include: {
        customer: true,
      },
    });

    if (!address || address.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Address with ID ${id} not found`);
    }

    return address;
  }

  async findByCustomer(customerId: string) {
    return this.prisma.address.findMany({
      where: {
        customer_id: customerId,
        entity_status: EntityStatus.ACTIVE,
      },
      orderBy: {
        created_at: 'desc',
      },
    });
  }

  async update(id: string, updateAddressDto: UpdateAddressDto) {
    // Vérifier si l'adresse existe
    await this.findOne(id);

    // Si un customer_id est fourni, vérifier que le client existe
    if (updateAddressDto.customer_id) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: updateAddressDto.customer_id },
      });

      if (!customer || customer.entity_status !== EntityStatus.ACTIVE) {
        throw new NotFoundException(`Customer with ID ${updateAddressDto.customer_id} not found`);
      }
    }

    return this.prisma.address.update({
      where: { id },
      data: updateAddressDto,
    });
  }

  async remove(id: string) {
    // Vérifier si l'adresse existe
    await this.findOne(id);

    // Vérifier si l'adresse est utilisée dans des commandes
    const ordersWithAddress = await this.prisma.order.findMany({
      where: {
        address_id: id,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    if (ordersWithAddress.length > 0) {
      // Si des commandes utilisent cette adresse, effectuer un soft delete
      return this.prisma.address.update({
        where: { id },
        data: {
          entity_status: EntityStatus.DELETED,
        },
      });
    }

    // Sinon, suppression définitive
    return this.prisma.address.delete({
      where: { id },
    });
  }
}