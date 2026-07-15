import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ComboGame, ComboGameStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { RewardService } from 'src/modules/fidelity/services/reward.service';
import { ComboItemDto } from '../dto/combo-item.dto';

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

  // ── Normalisation / comparaison de combinaisons ───────────────────────────

  /**
   * Normalise une combinaison en un ENSEMBLE de clés `type:id` (dédupliqué,
   * ordre indifférent). Deux combinaisons sont égales ssi leurs ensembles le sont.
   */
  private normalize(items: Array<{ type: string; id: string }>): Set<string> {
    const set = new Set<string>();
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || !it.type) continue;
      set.add(`${String(it.type).toUpperCase()}:${it.id}`);
    }
    return set;
  }

  private combosEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
  }

  // ── Jouer (client) ────────────────────────────────────────────────────────

  /**
   * Soumet une tentative. Vérifie l'ouverture + la fenêtre, applique le plafond
   * strict d'essais (RG-10), horodate, et renvoie { correct, attempts_left } SANS
   * jamais révéler la solution.
   */
  async submitAttempt(customerId: string, gameId: string, answer: ComboItemDto[]) {
    const game = await this.prisma.comboGame.findUnique({ where: { id: gameId } });
    if (!game) throw new NotFoundException('Jeu introuvable');

    const now = new Date();
    const inWindow = game.starts_at <= now && game.ends_at > now;
    if (game.status !== ComboGameStatus.OPEN || !inWindow) {
      throw new BadRequestException("Ce jeu n'est pas ouvert.");
    }

    // Si le client a DÉJÀ trouvé, on ne consomme pas d'essai supplémentaire.
    const alreadyCorrect = await this.prisma.comboAttempt.findFirst({
      where: { combo_game_id: gameId, customer_id: customerId, is_correct: true },
      select: { id: true },
    });
    const used = await this.prisma.comboAttempt.count({
      where: { combo_game_id: gameId, customer_id: customerId },
    });
    if (alreadyCorrect) {
      return { correct: true, attempts_left: Math.max(0, game.max_attempts - used) };
    }

    // RG-10 : plafond STRICT côté serveur (anti-triche).
    if (used >= game.max_attempts) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Nombre d'essais épuisé (${game.max_attempts} max).`,
          attempts_left: 0,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const solution = this.normalize((game.solution as Array<{ type: string; id: string }>) ?? []);
    const proposed = this.normalize(answer ?? []);
    const isCorrect = this.combosEqual(solution, proposed);

    await this.prisma.comboAttempt.create({
      data: {
        combo_game_id: gameId,
        customer_id: customerId,
        answer: (answer ?? []) as unknown as Prisma.InputJsonValue,
        is_correct: isCorrect,
      },
    });

    return { correct: isCorrect, attempts_left: Math.max(0, game.max_attempts - (used + 1)) };
  }

  // ── Lecture (client) ──────────────────────────────────────────────────────

  /** Structure attendue = liste des TYPES d'items à composer (jamais les ids). */
  private expectedStructure(game: ComboGame): string[] {
    const solution = (game.solution as Array<{ type: string; id: string }>) ?? [];
    return solution.map((i) => String(i.type).toUpperCase());
  }

  /** Le jeu OPEN courant + l'état du client (essais restants, déjà joué). */
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

    return {
      id: game.id,
      title: game.title,
      description: game.description,
      clues: game.clues,
      structure: this.expectedStructure(game),
      ends_at: game.ends_at,
      max_attempts: game.max_attempts,
      attempts_left: Math.max(0, game.max_attempts - used),
      has_played: used > 0,
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

    // SCHEDULED → OPEN (fenêtre active)
    await this.prisma.comboGame.updateMany({
      where: { status: ComboGameStatus.SCHEDULED, starts_at: { lte: now }, ends_at: { gt: now } },
      data: { status: ComboGameStatus.OPEN, updated_at: new Date() },
    });

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
