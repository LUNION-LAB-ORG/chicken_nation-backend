import { Injectable, NotFoundException } from '@nestjs/common';
import { SupplementCategory } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateSupplementDto } from 'src/modules/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/modules/menu/dto/update-supplement.dto';

@Injectable()
export class SupplementService {
  constructor(private prisma: PrismaService) { }

  async create(createSupplementDto: CreateSupplementDto) {
    return this.prisma.supplement.create({
      data: createSupplementDto,
    });
  }

  async findAll() {
    // Regrouper les suppléments par catégorie
    const supplements = await this.prisma.supplement.findMany({
      orderBy: {
        name: 'asc',
      },
    });

    // Organisez les suppléments par catégorie
    const supplementsByCategory = {
      [SupplementCategory.FOOD]: supplements.filter(
        (s) => s.category === SupplementCategory.FOOD,
      ),
      [SupplementCategory.DRINK]: supplements.filter(
        (s) => s.category === SupplementCategory.DRINK,
      ),
      [SupplementCategory.ACCESSORY]: supplements.filter(
        (s) => s.category === SupplementCategory.ACCESSORY,
      ),
    };

    return supplementsByCategory;
  }

  async findByCategory(category: SupplementCategory) {
    return this.prisma.supplement.findMany({
      where: {
        category,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOne(id: string) {
    const supplement = await this.prisma.supplement.findUnique({
      where: { id },
    });

    if (!supplement) {
      throw new NotFoundException(`Supplement non trouvée`);
    }

    return supplement;
  }

  async update(id: string, updateSupplementDto: UpdateSupplementDto) {
    await this.findOne(id);

    return this.prisma.supplement.update({
      where: { id },
      data: updateSupplementDto,
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.supplement.delete({
      where: { id },
    });
  }
}
