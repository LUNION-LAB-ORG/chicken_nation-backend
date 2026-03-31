import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateReasonDto } from './dto/create-reason.dto';
import { UpdateReasonDto } from './dto/update-reason.dto';
import { EntityStatus } from '@prisma/client';

@Injectable()
export class RetentionCallbackReasonService {
  private readonly logger = new Logger(RetentionCallbackReasonService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateReasonDto) {
    const exists = await this.prisma.retentionCallbackReason.findFirst({
      where: { name: dto.name, entity_status: { not: EntityStatus.DELETED } },
    });
    if (exists) throw new HttpException('Ce nom de raison existe déjà', 409);

    const maxPos = await this.prisma.retentionCallbackReason.aggregate({
      _max: { position: true },
      where: { entity_status: { not: EntityStatus.DELETED } },
    });

    return this.prisma.retentionCallbackReason.create({
      data: { ...dto, position: dto.position ?? (maxPos._max.position ?? 0) + 1 },
    });
  }

  async findAll() {
    return this.prisma.retentionCallbackReason.findMany({
      where: { entity_status: { not: EntityStatus.DELETED } },
      orderBy: { position: 'asc' },
    });
  }

  async findOne(id: string) {
    const reason = await this.prisma.retentionCallbackReason.findUnique({ where: { id } });
    if (!reason || reason.entity_status === EntityStatus.DELETED) {
      throw new HttpException('Raison non trouvée', 404);
    }
    return reason;
  }

  async update(id: string, dto: UpdateReasonDto) {
    await this.findOne(id);
    return this.prisma.retentionCallbackReason.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.retentionCallbackReason.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED },
    });
  }

  async reorder(ids: string[]) {
    const updates = ids.map((id, index) =>
      this.prisma.retentionCallbackReason.update({
        where: { id },
        data: { position: index },
      }),
    );
    await this.prisma.$transaction(updates);
    return this.findAll();
  }
}
