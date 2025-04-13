import { Injectable } from '@nestjs/common';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { Customer } from '@prisma/client';

@Injectable()
export class CustomerService {
  constructor(private readonly prisma: PrismaService) { }
  create(createCustomerDto: CreateCustomerDto) {
    return 'This action adds a new customer';
  }

  findAll() {
    return `This action returns all customer`;
  }

  async detail(req: Request) {
    const customer = req.user as Customer;
    return customer;
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id }
    });

    if (!customer) {
      throw new NotFoundException(`Utilisateur non trouvé`);
    }
    return customer;
  }

  async update(req: Request, updateCustomerDto: UpdateCustomerDto) {
    const id = (req.user as Customer).id;

    return this.prisma.customer.update({
      where: { id },
      data: updateCustomerDto,
    });
  }

  remove(id: number) {
    return `This action removes a #${id} customer`;
  }
}

