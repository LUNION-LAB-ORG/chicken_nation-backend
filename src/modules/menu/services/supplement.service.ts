import { Injectable, NotFoundException } from '@nestjs/common';
import { SupplementCategory } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateSupplementDto } from 'src/modules/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/modules/menu/dto/update-supplement.dto';
import { S3Service } from '../../../s3/s3.service';

@Injectable()
export class SupplementService {
  constructor(
    private prisma: PrismaService,
    private readonly s3service: S3Service,
  ) { }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/supplements',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  async create(createSupplementDto: CreateSupplementDto, image?: Express.Multer.File) {
    const uploadResult = await this.uploadImage(image);

    return this.prisma.supplement.create({
      data: {
        ...createSupplementDto,
        image: uploadResult?.key ?? createSupplementDto.image,
      },
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

    return {
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

  async update(id: string, updateSupplementDto: UpdateSupplementDto, image?: Express.Multer.File) {
    await this.findOne(id);

    const uploadResult = await this.uploadImage(image);

    return this.prisma.supplement.update({
      where: { id },
      data: {
        ...updateSupplementDto,
        image: uploadResult?.key ?? updateSupplementDto.image,
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.supplement.delete({
      where: { id },
    });
  }
}
