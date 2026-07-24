import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ComboGame, ComboGameStatus, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { RewardService } from 'src/modules/fidelity/services/reward.service';

/**
 * Moteur du COMBO MYSTÈRE : jouer (essais bornés RG-10), lire le jeu courant /
 * son résultat, et RÉGLER une partie (tirage au sort de N gagnants + récompense
 * via le système Reward). Le back office ne fait que configurer ; toute la logique
 * de jeu et de distribution vit ici.
 */
@Injectable()
export class ComboService {
  private readonly logger = new Logger(ComboService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rewardService: RewardService,
    private readonly expoPushService: ExpoPushService,
  ) {}

  // ── Jouer (client) ────────────────────────────────────────────────────────

  /**
   * Soumet une tentative (un item choisi par slot). Vérifie l'ouverture + la
   * fenêtre, applique le plafond strict d'essais (RG-10), horodate, et renvoie
   * l'état au format app { correct, attempts_used, attempts_remaining,
   * max_attempts, already_found, message } SANS jamais révéler la solution.
   *
   * Comparaison par ENSEMBLE d'ids (ordre/slot indifférent) : la bonne
   * combinaison = l'ensemble des item_id choisis == l'ensemble des ids de la
   * solution. Les ids étant uniques (UUID), le type est redondant.
   */
  async submitAttempt(
    customerId: string,
    gameId: string,
    selections: Array<{ slot_id?: string; item_id: string }>,
  ) {
    const game = await this.prisma.comboGame.findUnique({ where: { id: gameId } });
    if (!game) throw new NotFoundException('Jeu introuvable');

    const now = new Date();
    const inWindow = game.starts_at <= now && game.ends_at > now;
    if (game.status !== ComboGameStatus.OPEN || !inWindow) {
      throw new BadRequestException("Ce jeu n'est pas ouvert.");
    }

    const max = game.max_attempts;

    // Si le client a DÉJÀ trouvé, on ne consomme pas d'essai supplémentaire.
    const alreadyCorrect = await this.prisma.comboAttempt.findFirst({
      where: { combo_game_id: gameId, customer_id: customerId, is_correct: true },
      select: { id: true },
    });
    const used = await this.prisma.comboAttempt.count({
      where: { combo_game_id: gameId, customer_id: customerId },
    });
    if (alreadyCorrect) {
      return {
        correct: true,
        attempts_used: used,
        attempts_remaining: Math.max(0, max - used),
        max_attempts: max,
        already_found: true,
        message: 'Tu as déjà trouvé la combinaison — tu es dans le tirage 🎉',
      };
    }

    // RG-10 : plafond STRICT côté serveur (anti-triche).
    if (used >= max) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Nombre d'essais épuisé (${max} max).`,
          attempts_used: used,
          attempts_remaining: 0,
          max_attempts: max,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const solutionIds = new Set(
      ((game.solution as Array<{ type: string; id: string }>) ?? [])
        .map((s) => s?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const proposedIds = new Set(
      (selections ?? [])
        .map((s) => s?.item_id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const isCorrect =
      solutionIds.size > 0 &&
      solutionIds.size === proposedIds.size &&
      [...solutionIds].every((id) => proposedIds.has(id));

    await this.prisma.comboAttempt.create({
      data: {
        combo_game_id: gameId,
        customer_id: customerId,
        answer: (selections ?? []) as unknown as Prisma.InputJsonValue,
        is_correct: isCorrect,
      },
    });

    const newUsed = used + 1;
    return {
      correct: isCorrect,
      attempts_used: newUsed,
      attempts_remaining: Math.max(0, max - newUsed),
      max_attempts: max,
      already_found: isCorrect,
      message: isCorrect
        ? 'Bravo, tu es dans le tirage au sort 🎉'
        : `Ce n'est pas la bonne combinaison. Essais restants : ${Math.max(0, max - newUsed)}.`,
    };
  }

  // ── Lecture (client) ──────────────────────────────────────────────────────

  /** Hash déterministe (djb2) d'une chaîne → entier positif. Sert à mélanger les
   *  propositions de façon STABLE (mêmes options à chaque fetch, pour tous). */
  private hashStr(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }

  /** 4 propositions par catégorie (grille 2×2 côté app) : la bonne + 3 leurres. */
  private static readonly DECOYS_PER_SLOT = 3;

  /**
   * Construit les « slots » jouables : pour chaque item de la solution, une ligne
   * avec la bonne réponse + N leurres du MÊME type (menu réel), MÉLANGÉS de façon
   * DÉTERMINISTE (mêmes options à chaque fetch, identiques pour tous). La solution
   * n'est jamais révélée : elle est noyée dans les propositions.
   */
  private async buildSlots(game: ComboGame): Promise<
    Array<{
      id: string;
      label: string;
      item_type: 'DISH' | 'SUPPLEMENT';
      options: Array<{
        id: string;
        item_type: 'DISH' | 'SUPPLEMENT';
        name: string;
        image: string | null;
        price: number | null;
      }>;
    }>
  > {
    const solution = ((game.solution as Array<{ type: string; id: string }>) ?? [])
      .filter((s) => s && s.id && s.type)
      .map((s) => ({ type: String(s.type).toUpperCase() as 'DISH' | 'SUPPLEMENT', id: s.id }));
    if (solution.length === 0) return [];

    const solutionIds = new Set(solution.map((s) => s.id));

    // Catalogue menu réel : source des propositions + noms/prix/images.
    const [dishes, supplements] = await Promise.all([
      this.prisma.dish.findMany({
        where: { entity_status: { not: EntityStatus.DELETED } },
        select: { id: true, name: true, price: true, image: true },
      }),
      this.prisma.supplement.findMany({
        where: { available: true },
        select: { id: true, name: true, price: true, image: true },
      }),
    ]);
    const byId = new Map<string, { name: string; price: number; image: string | null }>();
    for (const d of dishes) byId.set(d.id, { name: d.name, price: d.price, image: d.image ?? null });
    for (const s of supplements) byId.set(s.id, { name: s.name, price: s.price, image: s.image ?? null });

    const dishPool = dishes.filter((d) => !solutionIds.has(d.id)).map((d) => d.id);
    const suppPool = supplements.filter((s) => !solutionIds.has(s.id)).map((s) => s.id);

    const totalByType = solution.reduce(
      (acc, s) => ((acc[s.type] = (acc[s.type] ?? 0) + 1), acc),
      {} as Record<'DISH' | 'SUPPLEMENT', number>,
    );
    const seen = { DISH: 0, SUPPLEMENT: 0 } as Record<'DISH' | 'SUPPLEMENT', number>;

    const toOption = (id: string, type: 'DISH' | 'SUPPLEMENT') => {
      const it = byId.get(id);
      return {
        id,
        item_type: type,
        name: it?.name ?? 'Article',
        image: it?.image ?? null,
        price: it?.price ?? null,
      };
    };

    return solution.map((sol, i) => {
      const pool = sol.type === 'DISH' ? dishPool : suppPool;
      // Leurres déterministes : trie le pool par hash(game:slot:id), prend les N premiers.
      const decoys = pool
        .map((id) => ({ id, h: this.hashStr(`${game.id}:${i}:${id}`) }))
        .sort((a, b) => a.h - b.h)
        .slice(0, ComboService.DECOYS_PER_SLOT)
        .map((x) => x.id);
      // Mélange déterministe de [bonne réponse + leurres].
      const optionIds = [sol.id, ...decoys]
        .map((id) => ({ id, h: this.hashStr(`${game.id}:opt:${i}:${id}`) }))
        .sort((a, b) => a.h - b.h)
        .map((x) => x.id);

      seen[sol.type] += 1;
      // Terminologie métier de l'app : « Plat » / « Supplément » (cf. panier).
      const label =
        sol.type === 'DISH'
          ? totalByType.DISH > 1
            ? `Plat ${seen.DISH}`
            : 'Plat'
          : totalByType.SUPPLEMENT > 1
            ? `Supplément ${seen.SUPPLEMENT}`
            : 'Supplément';

      return {
        id: `${sol.type}_${i}`,
        label,
        item_type: sol.type,
        options: optionIds.map((id) => toOption(id, sol.type)),
      };
    });
  }

  /**
   * Le jeu OPEN courant + l'état du client, AU FORMAT ATTENDU PAR L'APP
   * (hints, status, attempts_used/remaining, already_found, slots, reward_label).
   */
  async getCurrent(customerId: string) {
    const now = new Date();
    const game = await this.prisma.comboGame.findFirst({
      where: { status: ComboGameStatus.OPEN, starts_at: { lte: now }, ends_at: { gt: now } },
      orderBy: { ends_at: 'asc' },
    });
    if (!game) return null;

    const used = await this.prisma.comboAttempt.count({
      where: { combo_game_id: game.id, customer_id: customerId },
    });
    const alreadyFound = await this.prisma.comboAttempt.findFirst({
      where: { combo_game_id: game.id, customer_id: customerId, is_correct: true },
      select: { id: true },
    });
    const prize =
      (game.prize as { payload?: { label?: string; name?: string; image?: string } }) ?? {};
    const rewardLabel = prize.payload?.label || prize.payload?.name || null;

    return {
      id: game.id,
      title: game.title,
      description: game.description,
      hints: (game.clues as string[]) ?? [],
      status: game.status,
      ends_at: game.ends_at,
      max_attempts: game.max_attempts,
      attempts_used: used,
      attempts_remaining: Math.max(0, game.max_attempts - used),
      already_found: !!alreadyFound,
      slots: await this.buildSlots(game),
      reward_label: rewardLabel,
      reward_name: prize.payload?.name ?? null,
      reward_image: prize.payload?.image ?? null,
      winners_count: game.winners_count,
    };
  }

  /** Résultat d'une partie SETTLED pour le client : a-t-il gagné ? */
  async getResult(customerId: string, gameId: string) {
    const game = await this.prisma.comboGame.findUnique({
      where: { id: gameId },
      select: { id: true, title: true, status: true, settled_at: true, winners_count: true },
    });
    if (!game) throw new NotFoundException('Jeu introuvable');

    const settled = game.status === ComboGameStatus.SETTLED;
    const winner = settled
      ? await this.prisma.comboWinner.findUnique({
          where: { combo_game_id_customer_id: { combo_game_id: gameId, customer_id: customerId } },
          select: { id: true, reward_id: true },
        })
      : null;

    return {
      id: game.id,
      title: game.title,
      status: game.status,
      settled,
      won: !!winner,
      reward_id: winner?.reward_id ?? null,
      winners_count: game.winners_count,
    };
  }

  // ── Cycle de vie + règlement ──────────────────────────────────────────────

  /**
   * Balayage cycle de vie (appelé par le cron) : ouvre les SCHEDULED arrivés à
   * échéance, ferme les jeux dont la fenêtre est passée, puis RÈGLE les CLOSED.
   * Chaque transition est idempotente (updateMany conditionné par le statut).
   */
  async processLifecycle() {
    const now = new Date();

    // SCHEDULED → OPEN (fenêtre active) : claim atomique PAR jeu + push d'ouverture
    // une seule fois (le claim garantit qu'un seul process/backend notifie).
    const toOpen = await this.prisma.comboGame.findMany({
      where: { status: ComboGameStatus.SCHEDULED, starts_at: { lte: now }, ends_at: { gt: now } },
      select: { id: true },
    });
    for (const g of toOpen) {
      const claim = await this.prisma.comboGame.updateMany({
        where: { id: g.id, status: ComboGameStatus.SCHEDULED },
        data: { status: ComboGameStatus.OPEN, updated_at: new Date() },
      });
      if (claim.count === 1) {
        const opened = await this.prisma.comboGame.findUnique({ where: { id: g.id } });
        if (opened) {
          await this.notifyGameOpened(opened).catch((e) =>
            this.logger.error(`Push ouverture Combo ${g.id} échoué: ${(e as Error)?.message}`),
          );
        }
      }
    }

    // OPEN|SCHEDULED → CLOSED (fenêtre terminée ; un SCHEDULED jamais ouvert bascule direct)
    await this.prisma.comboGame.updateMany({
      where: {
        status: { in: [ComboGameStatus.OPEN, ComboGameStatus.SCHEDULED] },
        ends_at: { lte: now },
      },
      data: { status: ComboGameStatus.CLOSED, updated_at: new Date() },
    });

    // CLOSED → SETTLED (tirage) — chaque partie règle via son propre claim atomique.
    const toSettle = await this.prisma.comboGame.findMany({
      where: { status: ComboGameStatus.CLOSED },
      select: { id: true },
    });
    for (const g of toSettle) {
      try {
        await this.settleGame(g.id);
      } catch (e) {
        this.logger.error(`Échec règlement Combo ${g.id}: ${(e as Error)?.message}`);
      }
    }
  }

  /**
   * Règle UNE partie CLOSED : tire au sort winners_count gagnants parmi les
   * clients ayant au moins une bonne réponse, crée un ComboWinner + un Reward GIFT
   * par gagnant (réutilise le système Reward), notifie, et passe le jeu SETTLED.
   *
   * IDEMPOTENT : claim atomique CLOSED→SETTLED AVANT distribution (borne le coût :
   * une seule instance tire) + contrainte UNIQUE ComboWinner (anti-doublon gagnant).
   * Rejouable : si déjà SETTLED, no-op.
   */
  async settleGame(gameId: string) {
    const game = await this.prisma.comboGame.findUnique({ where: { id: gameId } });
    if (!game) throw new NotFoundException('Jeu introuvable');
    if (game.status === ComboGameStatus.SETTLED) {
      return { settled: false, already: true, winners: 0 };
    }
    if (game.status !== ComboGameStatus.CLOSED) {
      throw new BadRequestException('Le jeu doit être clôturé (CLOSED) avant règlement.');
    }

    // Claim atomique : seule l'instance qui bascule CLOSED→SETTLED distribue.
    const claim = await this.prisma.comboGame.updateMany({
      where: { id: gameId, status: ComboGameStatus.CLOSED },
      data: { status: ComboGameStatus.SETTLED, settled_at: new Date(), updated_at: new Date() },
    });
    if (claim.count === 0) {
      return { settled: false, already: true, winners: 0 };
    }

    // Clients ayant AU MOINS une bonne réponse (distincts).
    const correct = await this.prisma.comboAttempt.findMany({
      where: { combo_game_id: gameId, is_correct: true },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });
    let candidates = correct.map((c) => c.customer_id);
    if (candidates.length === 0) {
      this.logger.log(`Combo ${gameId} réglé : aucune bonne réponse, aucun gagnant.`);
      return { settled: true, already: false, winners: 0 };
    }

    // Tirage au sort (Fisher-Yates partiel) — borné à winners_count.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const winners = candidates.slice(0, Math.max(1, game.winners_count));

    const prize = (game.prize ?? {}) as { reward_type?: string; payload?: Record<string, any> };
    const prizePayload = prize.payload ?? {};

    const rewarded: string[] = [];
    for (const customerId of winners) {
      // 1) Crée D'ABORD la récompense GIFT via le SYSTÈME REWARD (récupérable au
      // panier à 0 fr). Si le lot échoue (ex. blip Neon transitoire), on log et on
      // IGNORE ce gagnant : aucun ComboWinner orphelin (= sans récompense) n'est
      // inséré, et le règlement continue pour les autres gagnants.
      let reward: { id: string };
      try {
        reward = await this.rewardService.createGiftReward({
          customer_id: customerId,
          payload: prizePayload,
          reason: `Combo Mystère — ${game.title}`,
        });
      } catch (e) {
        this.logger.error(
          `Combo ${gameId} : échec création du lot pour ${customerId}, gagnant ignoré: ${(e as Error)?.message}`,
        );
        continue;
      }

      // 2) PUIS enregistre le gagnant avec reward_id renseigné. Anti-doublon
      // gagnant (UNIQUE combo_game_id,customer_id) : P2002 avalé (idempotent).
      try {
        await this.prisma.comboWinner.create({
          data: { combo_game_id: gameId, customer_id: customerId, reward_id: reward.id },
        });
        rewarded.push(customerId);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Gagnant déjà enregistré (settle rejoué / concurrence) → idempotent.
          continue;
        }
        this.logger.error(
          `Combo ${gameId} : échec enregistrement gagnant ${customerId}: ${(e as Error)?.message}`,
        );
      }
    }

    this.sendWinnerPush(rewarded, game.title).catch((e) =>
      this.logger.warn(`Push gagnants Combo ${gameId} échoué: ${e?.message}`),
    );

    this.logger.log(`Combo ${gameId} réglé : ${rewarded.length} gagnant(s) récompensé(s).`);
    return { settled: true, already: false, winners: rewarded.length };
  }

  /**
   * Push « nouveau Combo Mystère » à TOUS les clients opt-in, à l'ouverture du
   * jeu (une seule fois — cf. claim atomique côté appelant). Best-effort : n'
   * interrompt jamais la création / le cycle de vie. Le tap ouvre la page Combo
   * (data.type='combo' → handleNavigation côté app).
   */
  async notifyGameOpened(game: ComboGame) {
    const settings = await this.prisma.notificationSetting.findMany({
      where: { push: true, active: true, expo_push_token: { not: null } },
      select: { expo_push_token: true },
    });
    const tokens = [
      ...new Set(
        settings
          .map((s) => s.expo_push_token)
          .filter((t): t is string => !!t),
      ),
    ];
    if (tokens.length === 0) return;

    const prize = (game.prize as { payload?: { label?: string; name?: string } }) ?? {};
    const rewardLabel = prize.payload?.label || prize.payload?.name || 'un cadeau';

    await this.expoPushService.sendPushNotifications({
      tokens,
      title: '🎮 Nouveau Combo Mystère !',
      body: `${game.title} — devine la combinaison et tente de gagner ${rewardLabel}. À toi de jouer !`,
      sound: 'default',
      priority: 'high',
      data: { type: 'combo' },
    });
  }

  private async sendWinnerPush(customerIds: string[], title: string) {
    if (customerIds.length === 0) return;
    const settings = await this.prisma.notificationSetting.findMany({
      where: {
        customer_id: { in: customerIds },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
      select: { expo_push_token: true },
    });
    const tokens = settings.map((s) => s.expo_push_token).filter((t): t is string => !!t);
    if (tokens.length === 0) return;

    await this.expoPushService.sendPushNotifications({
      tokens,
      title: '🎉 Vous avez gagné le Combo Mystère !',
      body: `Bravo ! Votre cadeau « ${title} » vous attend dans l'app.`,
      sound: 'default',
      priority: 'high',
      data: { type: 'combo_win' },
    });
  }
}
