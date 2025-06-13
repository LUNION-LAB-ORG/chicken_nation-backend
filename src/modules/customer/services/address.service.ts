import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';
import { Customer, EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { Request } from 'express';

@Injectable()
export class AddressService {
  constructor(private prisma: PrismaService) { }

  async create(req: Request, createAddressDto: CreateAddressDto) {
    const customer = req.user as Customer;

    return this.prisma.address.create({
      data: {
        ...createAddressDto,
        customer_id: customer.id,
      },
    });
  }

  async findAll() {
    return this.prisma.address.findMany({
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

    if (!address) {
      throw new NotFoundException(`Address with ID ${id} not found`);
    }

    return address;
  }

  async findByCustomer(customerId: string) {
    return this.prisma.address.findMany({
      where: {
        customer_id: customerId,
      },
      orderBy: {
        created_at: 'desc',
      },
    });
  }

  async update(req: Request, id: string, updateAddressDto: UpdateAddressDto) {
    // Vérifier si l'adresse existe
    await this.findOne(id);

    return this.prisma.address.update({
      where: { id },
      data: updateAddressDto,
    });
  }

  async remove(id: string) {
    // Vérifier si l'adresse existe
    await this.findOne(id);

    // Sinon, suppression définitive
    return this.prisma.address.delete({
      where: { id },
    });
  }
}