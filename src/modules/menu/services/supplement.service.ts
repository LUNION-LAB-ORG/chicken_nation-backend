import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupplementCategory } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateSupplementDto } from 'src/modules/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/modules/menu/dto/update-supplement.dto';
import { S3Service } from '../../../s3/s3.service';
import { SupplementEvent } from 'src/modules/menu/events/supplement.event';

@Injectable()
export class SupplementService {
  private readonly logger = new Logger(SupplementService.name);

  constructor(
    private prisma: PrismaService,
    private readonly s3service: S3Service,
    private readonly supplementEvent: SupplementEvent,
  ) { }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image || !image.buffer) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/supplements',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  async create(createSupplementDto: CreateSupplementDto, image?: Express.Multer.File) {
    const uploadResult = await this.uploadImage(image);

    const supplement = await this.prisma.supplement.create({
      data: {
        ...createSupplementDto,
        image: uploadResult?.key ?? createSupplementDto.image,
      },
    });

    this.supplementEvent.createSupplement(supplement);

    return supplement;
  }

  async findAll() {
    // Regrouper les suppléments par catégorie
    const supplements = await this.prisma.supplement.findMany({
      // Position d'abord, nom en second : deux suppléments jamais classés
      // gardent ainsi un ordre stable au lieu de sortir au hasard.
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
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

  /**
   * Applique un nouvel ordre d'affichage.
   *
   * La position est réécrite pour TOUS les suppléments transmis, à partir de 1.
   * En une seule transaction : un ordre à moitié appliqué laisserait deux
   * suppléments au même rang, donc un affichage arbitraire entre les deux.
   */
  async reorder(ids: string[]) {
    const uniques = [...new Set(ids)];
    if (uniques.length !== ids.length) {
      throw new BadRequestException('Un supplément apparaît deux fois dans la liste');
    }

    const connus = await this.prisma.supplement.count({ where: { id: { in: uniques } } });
    if (connus !== uniques.length) {
      throw new BadRequestException("Un des suppléments n'existe plus");
    }

    await this.prisma.$transaction(
      uniques.map((id, index) =>
        this.prisma.supplement.update({
          where: { id },
          data: { position: index + 1 },
        }),
      ),
    );

    return { reordonnes: uniques.length };
  }

  async findByCategory(category: SupplementCategory) {
    return this.prisma.supplement.findMany({
      where: {
        category,
      },
      // Position d'abord, nom en second : deux suppléments jamais classés
      // gardent ainsi un ordre stable au lieu de sortir au hasard.
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
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
    const previous = await this.findOne(id);

    const uploadResult = await this.uploadImage(image);

    const supplement = await this.prisma.supplement.update({
      where: { id },
      data: {
        ...updateSupplementDto,
        ...(uploadResult?.key ? { image: uploadResult.key } : {}),
      },
    });

    // Chaque upload crée une clé NOUVELLE (`path/<timestamp>-nom`) : sans ce
    // nettoyage, l'ancien visuel resterait sur S3 indéfiniment à chaque
    // changement d'image. Best-effort APRÈS commit — un échec S3 ne doit
    // jamais faire échouer la mise à jour du supplément.
    if (uploadResult?.key && previous.image && previous.image !== uploadResult.key) {
      this.s3service
        .deleteFile(previous.image)
        .catch((e) =>
          this.logger.warn(`Ancienne image supplément non supprimée (${previous.image}) : ${e?.message}`),
        );
    }

    this.supplementEvent.updateSupplement(supplement);

    return supplement;
  }

  async remove(id: string) {
    await this.findOne(id);

    const supplement = await this.prisma.supplement.delete({
      where: { id },
    });

    this.supplementEvent.deleteSupplement(supplement);

    return supplement;
  }
}
