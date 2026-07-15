import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ComboGameStatus, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateComboGameDto } from '../dto/create-combo-game.dto';
import { UpdateComboGameDto } from '../dto/update-combo-game.dto';
import { ComboItemDto } from '../dto/combo-item.dto';

/**
 * CRUD des COMBO MYSTÈRE (back office). Valide la solution et le lot (prize)
 * contre le MENU RÉEL, snapshotte le plat offert (comme les campagnes Reward /
 * lots Gratte & Gagne). L'édition n'est plus possible une fois le jeu SETTLED.
 */
@Injectable()
export class ComboAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const games = await this.prisma.comboGame.findMany({ orderBy: { created_at: 'desc' } });
    // Compteurs de participation (bornés : 2 groupBy).
    const ids = games.map((g) => g.id);
    if (ids.length === 0) return [];

    const attempts = await this.prisma.comboAttempt.groupBy({
      by: ['combo_game_id'],
      where: { combo_game_id: { in: ids } },
      _count: { _all: true },
    });
    const winners = await this.prisma.comboWinner.groupBy({
      by: ['combo_game_id'],
      where: { combo_game_id: { in: ids } },
      _count: { _all: true },
    });
    const aMap = new Map(attempts.map((a) => [a.combo_game_id, a._count._all]));
    const wMap = new Map(winners.map((w) => [w.combo_game_id, w._count._all]));

    return games.map((g) => ({
      ...g,
      attempts_count: aMap.get(g.id) ?? 0,
      winners_count_actual: wMap.get(g.id) ?? 0,
    }));
  }

  async get(id: string) {
    const game = await this.prisma.comboGame.findUnique({ where: { id } });
    if (!game) throw new NotFoundException('Jeu introuvable');
    return game;
  }

  async create(dto: CreateComboGameDto, adminId: string) {
    const startsAt = new Date(dto.starts_at);
    const endsAt = new Date(dto.ends_at);
    this.assertWindow(startsAt, endsAt);

    const solution = await this.validateSolution(dto.solution);
    const prize = await this.buildPrizePayload(dto.prize);

    return this.prisma.comboGame.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        clues: (dto.clues ?? []) as unknown as Prisma.InputJsonValue,
        solution: solution as unknown as Prisma.InputJsonValue,
        starts_at: startsAt,
        ends_at: endsAt,
        max_attempts: dto.max_attempts ?? 3,
        winners_count: dto.winners_count ?? 1,
        prize: prize as unknown as Prisma.InputJsonValue,
        // Statut initial cohérent avec la fenêtre (le cron ajustera de toute façon).
        status: startsAt <= new Date() ? ComboGameStatus.OPEN : ComboGameStatus.SCHEDULED,
        created_by: adminId,
      },
    });
  }

  async update(id: string, dto: UpdateComboGameDto) {
    const game = await this.get(id);
    if (game.status === ComboGameStatus.SETTLED) {
      throw new BadRequestException('Un jeu réglé (SETTLED) ne peut plus être modifié.');
    }

    const startsAt = dto.starts_at !== undefined ? new Date(dto.starts_at) : game.starts_at;
    const endsAt = dto.ends_at !== undefined ? new Date(dto.ends_at) : game.ends_at;
    if (dto.starts_at !== undefined || dto.ends_at !== undefined) {
      this.assertWindow(startsAt, endsAt);
    }

    const solution =
      dto.solution !== undefined ? await this.validateSolution(dto.solution) : undefined;
    const prize = dto.prize !== undefined ? await this.buildPrizePayload(dto.prize) : undefined;

    return this.prisma.comboGame.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.clues !== undefined && { clues: dto.clues as unknown as Prisma.InputJsonValue }),
        ...(solution !== undefined && { solution: solution as unknown as Prisma.InputJsonValue }),
        ...(dto.starts_at !== undefined && { starts_at: startsAt }),
        ...(dto.ends_at !== undefined && { ends_at: endsAt }),
        ...(dto.max_attempts !== undefined && { max_attempts: dto.max_attempts }),
        ...(dto.winners_count !== undefined && { winners_count: dto.winners_count }),
        ...(prize !== undefined && { prize: prize as unknown as Prisma.InputJsonValue }),
      },
    });
  }

  async remove(id: string) {
    const game = await this.get(id);
    if (game.status === ComboGameStatus.SETTLED) {
      throw new BadRequestException('Un jeu réglé ne peut pas être supprimé (audit des gagnants).');
    }
    const played = await this.prisma.comboAttempt.count({ where: { combo_game_id: id } });
    if (played > 0) {
      // Des participations existent → on désactive en clôturant plutôt que supprimer.
      return this.prisma.comboGame.update({
        where: { id },
        data: { status: ComboGameStatus.CLOSED, updated_at: new Date() },
      });
    }
    return this.prisma.comboGame.delete({ where: { id } });
  }

  /** Participations + gagnants d'une partie (back office). */
  async participations(id: string) {
    await this.get(id);
    const [attempts, winners] = await Promise.all([
      this.prisma.comboAttempt.findMany({
        where: { combo_game_id: id },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.comboWinner.findMany({
        where: { combo_game_id: id },
        orderBy: { created_at: 'desc' },
      }),
    ]);
    return { attempts, winners };
  }

  // ── Validation menu réel ──────────────────────────────────────────────────

  private assertWindow(startsAt: Date, endsAt: Date) {
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime())) {
      throw new BadRequestException('Dates invalides.');
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException("La clôture (ends_at) doit être après l'ouverture (starts_at).");
    }
  }

  /**
   * Vérifie que chaque item de la combinaison-solution existe et est disponible
   * dans le MENU RÉEL. Renvoie la solution normalisée [{ type, id }].
   */
  private async validateSolution(items: ComboItemDto[]): Promise<Array<{ type: string; id: string }>> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('La solution doit contenir au moins un item.');
    }
    const dishIds = items.filter((i) => i.type === 'DISH').map((i) => i.id);
    const suppIds = items.filter((i) => i.type === 'SUPPLEMENT').map((i) => i.id);

    if (dishIds.length > 0) {
      const dishes = await this.prisma.dish.findMany({
        where: { id: { in: dishIds }, entity_status: { not: EntityStatus.DELETED } },
        select: { id: true },
      });
      const found = new Set(dishes.map((d) => d.id));
      const missing = dishIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(`Plat(s) introuvable(s) dans la solution : ${missing.join(', ')}`);
      }
    }
    if (suppIds.length > 0) {
      const supps = await this.prisma.supplement.findMany({
        where: { id: { in: suppIds } },
        select: { id: true },
      });
      const found = new Set(supps.map((s) => s.id));
      const missing = suppIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(`Supplément(s) introuvable(s) dans la solution : ${missing.join(', ')}`);
      }
    }
    return items.map((i) => ({ type: i.type, id: i.id }));
  }

  /**
   * Valide + snapshotte le LOT (prize). V1 : GIFT (plat offert) uniquement, aligné
   * sur RewardCampaignService.buildPayload(GIFT) / ScratchLotService — le plat est
   * figé (nom/prix/image) au moment de la config ; le settle recopie ce payload
   * dans le Reward GIFT du gagnant.
   */
  private async buildPrizePayload(
    prize: Record<string, any>,
  ): Promise<{ reward_type: 'GIFT'; payload: Record<string, any> }> {
    const rewardType = prize?.reward_type ?? 'GIFT';
    if (rewardType !== 'GIFT') {
      throw new BadRequestException('Le lot du Combo doit être de type GIFT (plat offert) en V1.');
    }
    const payload = (prize?.payload ?? {}) as Record<string, any>;
    const dishId = payload.dish_id;
    if (!dishId || typeof dishId !== 'string') {
      throw new BadRequestException('Sélectionnez le plat offert du lot (prize.payload.dish_id).');
    }
    const dish = await this.prisma.dish.findUnique({ where: { id: dishId } });
    if (!dish || dish.entity_status === EntityStatus.DELETED) {
      throw new BadRequestException('Plat du lot introuvable ou indisponible.');
    }
    return {
      reward_type: 'GIFT',
      payload: {
        item_type: 'DISH',
        dish_id: dish.id,
        label:
          typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : dish.name,
        name: dish.name,
        price: dish.price,
        ...(dish.image ? { image: dish.image } : {}),
      },
    };
  }
}
