import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ComboGameStatus, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateComboGameDto } from '../dto/create-combo-game.dto';
import { UpdateComboGameDto } from '../dto/update-combo-game.dto';
import { ComboItemDto } from '../dto/combo-item.dto';
import { ComboService } from './combo.service';

/**
 * CRUD des COMBO MYSTÈRE (back office). Valide la solution et le lot (prize)
 * contre le MENU RÉEL, snapshotte le plat offert (comme les campagnes Reward /
 * lots Gratte & Gagne). L'édition n'est plus possible une fois le jeu SETTLED.
 */
@Injectable()
export class ComboAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comboService: ComboService,
  ) {}

  async list() {
    const games = await this.prisma.comboGame.findMany({ orderBy: { created_at: 'desc' } });
    const ids = games.map((g) => g.id);
    if (ids.length === 0) return [];

    // JOUEURS DISTINCTS (pas nombre d'essais) + bonnes réponses distinctes :
    // groupBy [game, client] → 1 ligne par (partie, joueur), qu'on compte par partie.
    const [participantGroups, correctGroups, winnerGroups] = await Promise.all([
      this.prisma.comboAttempt.groupBy({
        by: ['combo_game_id', 'customer_id'],
        where: { combo_game_id: { in: ids } },
      }),
      this.prisma.comboAttempt.groupBy({
        by: ['combo_game_id', 'customer_id'],
        where: { combo_game_id: { in: ids }, is_correct: true },
      }),
      this.prisma.comboWinner.groupBy({
        by: ['combo_game_id'],
        where: { combo_game_id: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    const countByGame = (groups: Array<{ combo_game_id: string }>) => {
      const m = new Map<string, number>();
      for (const g of groups) m.set(g.combo_game_id, (m.get(g.combo_game_id) ?? 0) + 1);
      return m;
    };
    const participantsMap = countByGame(participantGroups);
    const correctMap = countByGame(correctGroups);
    const winnersMap = new Map(winnerGroups.map((w) => [w.combo_game_id, w._count._all]));

    const withCounts = games.map((g) => ({
      ...g,
      attempts_count: participantsMap.get(g.id) ?? 0, // = joueurs distincts
      correct_count: correctMap.get(g.id) ?? 0,
      winners_count_actual: winnersMap.get(g.id) ?? 0,
    }));

    return this.withSolutionNames(withCounts);
  }

  /** Getter brut (usage interne : update/remove/participations). */
  private async findGameOrThrow(id: string) {
    const game = await this.prisma.comboGame.findUnique({ where: { id } });
    if (!game) throw new NotFoundException('Jeu introuvable');
    return game;
  }

  async get(id: string) {
    const game = await this.findGameOrThrow(id);
    return (await this.withSolutionNames([game]))[0];
  }

  /**
   * Enrichit la `solution` de chaque jeu avec le NOM (et l'image) du plat /
   * supplément — le back office affiche des noms, jamais des UUID. Résolu en 2
   * requêtes groupées (pas de N+1), tolérant aux items supprimés.
   */
  private async withSolutionNames<T extends { solution: unknown }>(
    games: T[],
  ): Promise<T[]> {
    const items = games.flatMap(
      (g) => ((g.solution as Array<{ type?: string; id?: string }>) ?? []) as Array<{ type?: string; id?: string }>,
    );
    const dishIds = [
      ...new Set(
        items.filter((i) => String(i.type).toUpperCase() === 'DISH').map((i) => i.id!).filter(Boolean),
      ),
    ];
    const suppIds = [
      ...new Set(
        items.filter((i) => String(i.type).toUpperCase() === 'SUPPLEMENT').map((i) => i.id!).filter(Boolean),
      ),
    ];
    const [dishes, supps] = await Promise.all([
      dishIds.length
        ? this.prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, name: true, image: true } })
        : Promise.resolve([]),
      suppIds.length
        ? this.prisma.supplement.findMany({ where: { id: { in: suppIds } }, select: { id: true, name: true, image: true } })
        : Promise.resolve([]),
    ]);
    const byId = new Map<string, { name: string; image: string | null }>();
    for (const d of dishes) byId.set(d.id, { name: d.name, image: d.image ?? null });
    for (const s of supps) byId.set(s.id, { name: s.name, image: s.image ?? null });

    return games.map((g) => ({
      ...g,
      solution: ((g.solution as Array<{ type: string; id: string; quantity?: number }>) ?? []).map((s) => ({
        type: s.type,
        id: s.id,
        ...(s.quantity ? { quantity: s.quantity } : {}),
        name: byId.get(s.id)?.name ?? null,
        image: byId.get(s.id)?.image ?? null,
      })),
    }));
  }

  async create(dto: CreateComboGameDto, adminId: string) {
    const startsAt = new Date(dto.starts_at);
    const endsAt = new Date(dto.ends_at);
    this.assertWindow(startsAt, endsAt);

    const solution = await this.validateSolution(dto.solution);
    const prize = await this.buildPrizePayload(dto.prize);

    const created = await this.prisma.comboGame.create({
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

    // Jeu déjà ouvert à la création → push « nouveau Combo » à tous les clients
    // (best-effort, ne bloque jamais la création). Les jeux planifiés seront
    // notifiés par le cron à leur ouverture.
    if (created.status === ComboGameStatus.OPEN) {
      void this.comboService
        .notifyGameOpened(created)
        .catch(() => undefined);
    }

    return created;
  }

  async update(id: string, dto: UpdateComboGameDto) {
    const game = await this.findGameOrThrow(id);
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
    const game = await this.findGameOrThrow(id);
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

  /**
   * Participations + gagnants d'une partie (back office). Les tentatives sont
   * AGRÉGÉES PAR JOUEUR (1 ligne par client, pas 1 par essai) et enrichies du
   * nom / téléphone / image du client. `attempts` = participations agrégées
   * (le front lit `data.attempts`).
   */
  async participations(id: string) {
    await this.findGameOrThrow(id);
    const [rawAttempts, winnerRows] = await Promise.all([
      this.prisma.comboAttempt.findMany({
        where: { combo_game_id: id },
        orderBy: { created_at: 'asc' },
        select: { customer_id: true, is_correct: true, created_at: true },
      }),
      this.prisma.comboWinner.findMany({
        where: { combo_game_id: id },
        orderBy: { created_at: 'desc' },
        select: { id: true, customer_id: true, reward_id: true, created_at: true },
      }),
    ]);

    // Infos clients (nom/tel/image) en une seule requête.
    const customerIds = [
      ...new Set([...rawAttempts.map((a) => a.customer_id), ...winnerRows.map((w) => w.customer_id)]),
    ];
    const customers = customerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, first_name: true, last_name: true, phone: true, image: true },
        })
      : [];
    const cById = new Map(customers.map((c) => [c.id, c]));
    const nameOf = (cid: string) => {
      const c = cById.get(cid);
      const n = `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim();
      return n || null;
    };

    // Agrégation par CLIENT : 1 ligne par joueur.
    const byCustomer = new Map<
      string,
      { attempts_used: number; is_correct: boolean; answered_at: Date | null; last_attempt_at: Date | null }
    >();
    for (const a of rawAttempts) {
      const agg =
        byCustomer.get(a.customer_id) ??
        { attempts_used: 0, is_correct: false, answered_at: null, last_attempt_at: null };
      agg.attempts_used += 1;
      if (!agg.last_attempt_at || a.created_at > agg.last_attempt_at) agg.last_attempt_at = a.created_at;
      if (a.is_correct) {
        agg.is_correct = true;
        if (!agg.answered_at || a.created_at < agg.answered_at) agg.answered_at = a.created_at;
      }
      byCustomer.set(a.customer_id, agg);
    }

    const attempts = [...byCustomer.entries()]
      .sort(
        ([, a], [, b]) =>
          (b.last_attempt_at?.getTime() ?? 0) - (a.last_attempt_at?.getTime() ?? 0),
      )
      .map(([customerId, p]) => ({
        id: customerId,
        game_id: id,
        customer_id: customerId,
        customer_name: nameOf(customerId),
        customer_phone: cById.get(customerId)?.phone ?? null,
        customer_image: cById.get(customerId)?.image ?? null,
        attempts_used: p.attempts_used,
        is_correct: p.is_correct,
        answered_at: p.answered_at,
        last_attempt_at: p.last_attempt_at,
      }));

    const winners = winnerRows.map((w) => ({
      id: w.id,
      game_id: id,
      customer_id: w.customer_id,
      customer_name: nameOf(w.customer_id),
      customer_phone: cById.get(w.customer_id)?.phone ?? null,
      customer_image: cById.get(w.customer_id)?.image ?? null,
      reward_id: w.reward_id,
      drawn_at: w.created_at,
    }));

    return {
      attempts,
      winners,
      stats: {
        participants_count: attempts.length,
        correct_count: attempts.filter((p) => p.is_correct).length,
        winners_count: winners.length,
      },
    };
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
    const quantity = Number(payload.quantity);
    const qtyPart = Number.isFinite(quantity) && quantity > 0 ? { quantity } : {};

    // Lot = un PLAT ou un SUPPLÉMENT offert (aligné sur RewardCampaignService /
    // ScratchLotService). Supplément prioritaire s'il est fourni.
    if (payload.supplement_id) {
      const supp = await this.prisma.supplement.findUnique({ where: { id: payload.supplement_id } });
      if (!supp || supp.available === false) {
        throw new BadRequestException('Supplément du lot introuvable ou indisponible.');
      }
      return {
        reward_type: 'GIFT',
        payload: {
          item_type: 'SUPPLEMENT',
          supplement_id: supp.id,
          label:
            typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : supp.name,
          name: supp.name,
          price: supp.price,
          ...qtyPart,
          ...(supp.image ? { image: supp.image } : {}),
        },
      };
    }

    const dishId = payload.dish_id;
    if (!dishId || typeof dishId !== 'string') {
      throw new BadRequestException('Sélectionnez le plat ou le supplément offert du lot.');
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
        ...qtyPart,
        ...(dish.image ? { image: dish.image } : {}),
      },
    };
  }
}
