import { Injectable, NotFoundException } from '@nestjs/common';
import { Customer } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';

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

  /**
   * ⚠️ FAILLE CORRIGEE : `req` était reçu mais JAMAIS utilisé. Tout client
   * authentifié modifiait l'adresse de livraison d'un autre en connaissant son
   * identifiant, et pouvait ainsi détourner une livraison.
   *
   * L'écriture est désormais CONDITIONNEE au propriétaire dans le `where` :
   * c'est la base qui tranche, en une seule requête, sans fenêtre entre la
   * vérification et l'écriture.
   */
  async update(req: Request, id: string, updateAddressDto: UpdateAddressDto) {
    const customerId = (req.user as { id?: string })?.id;
    const { count } = await this.prisma.address.updateMany({
      where: { id, customer_id: customerId },
      data: updateAddressDto,
    });
    if (count === 0) {
      throw new NotFoundException('Adresse introuvable');
    }
    return this.findOne(id);
  }

  /**
   * ⚠️ FAILLE CORRIGEE : aucune vérification de propriétaire, sur une
   * suppression DEFINITIVE. Tout client authentifié effaçait irréversiblement
   * les adresses d'un autre.
   */
  async remove(id: string, customerId?: string) {
    if (customerId) {
      const { count } = await this.prisma.address.deleteMany({
        where: { id, customer_id: customerId },
      });
      if (count === 0) {
        throw new NotFoundException('Adresse introuvable');
      }
      return { id };
    }
    // Chemin PERSONNEL, déjà gardé par une permission au niveau de la route.
    await this.findOne(id);

    // Sinon, suppression définitive
    return this.prisma.address.delete({
      where: { id },
    });
  }
}