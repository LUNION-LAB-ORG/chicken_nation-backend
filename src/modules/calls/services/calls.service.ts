import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CallStatus,
  EntityStatus,
  Prisma,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { CALL_EVENTS } from '../constants/calls.constants';
import { StartCallDto } from '../dto/start-call.dto';
import { CallsConfigService } from './calls-config.service';
import { LunionMeetService } from './lunion-meet.service';

const TERMINAL_STATUSES: CallStatus[] = [
  CallStatus.ENDED,
  CallStatus.MISSED,
  CallStatus.CANCELLED,
  CallStatus.FAILED,
];

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lunion: LunionMeetService,
    private readonly config: CallsConfigService,
    private readonly gateway: AppGateway,
  ) {}

  /**
   * Démarre un appel (sonnerie de groupe) :
   * crée la room Lunion, résout les receveurs, persiste, sonne, et renvoie
   * l'accès (token + url) de l'appelant qui attend dans la room.
   */
  async start(caller: User, dto: StartCallDto) {
    const isAdmin = caller.role === UserRole.ADMIN;

    // L'admin peut cibler explicitement, au-delà de la config de routage.
    if (isAdmin && dto.targetKind === 'USER') {
      if (!dto.targetUserId) throw new BadRequestException('targetUserId requis');
      const target = await this.prisma.user.findFirst({
        where: { id: dto.targetUserId, entity_status: EntityStatus.ACTIVE },
        select: { id: true, fullname: true },
      });
      if (!target || target.id === caller.id) {
        throw new NotFoundException('Utilisateur cible introuvable');
      }
      return this.createAndRing(caller, {
        targetKind: 'USER',
        targetUserId: target.id,
        targetRestaurantId: null,
        receivers: [target],
        targetLabel: target.fullname,
      });
    }
    if (isAdmin && dto.targetKind === 'CALL_CENTER') {
      return this.startGroup(caller, 'CALL_CENTER', null);
    }
    if (isAdmin && dto.targetKind === 'RESTAURANT') {
      if (!dto.restaurantId) throw new BadRequestException('restaurantId requis');
      return this.startGroup(caller, 'RESTAURANT', dto.restaurantId);
    }

    // Non-admin (ou admin sans cible explicite) : config de routage.
    const config = await this.config.getForCaller(caller.type);
    if (!config.canCall) {
      throw new ForbiddenException("Votre profil n'est pas autorisé à passer des appels");
    }
    if (config.targetKind === 'RESTAURANT') {
      if (!dto.restaurantId) {
        throw new BadRequestException('restaurantId requis pour appeler un restaurant');
      }
      return this.startGroup(caller, 'RESTAURANT', dto.restaurantId);
    }
    return this.startGroup(caller, 'CALL_CENTER', null);
  }

  /** Appel de groupe (restaurant ou call center) : receveurs résolus via la config. */
  private async startGroup(
    caller: User,
    targetKind: 'RESTAURANT' | 'CALL_CENTER',
    restaurantId: string | null,
  ) {
    const cfg = await this.config.getConfig();
    let targetLabel: string;
    let receiverType: UserType;
    let receiverRoles: UserRole[];

    if (targetKind === 'RESTAURANT') {
      if (!restaurantId) throw new BadRequestException('restaurantId requis');
      const resto = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true },
      });
      if (!resto) throw new NotFoundException('Restaurant introuvable');
      targetLabel = resto.name;
      // Reçoivent un appel vers un restaurant = rôles configurés pour un appelant BACKOFFICE.
      receiverType = cfg[UserType.BACKOFFICE].receiverType;
      receiverRoles = cfg[UserType.BACKOFFICE].receiverRoles;
    } else {
      targetLabel = 'Call Center';
      // Reçoivent un appel vers le call center = rôles configurés pour un appelant RESTAURANT.
      receiverType = cfg[UserType.RESTAURANT].receiverType;
      receiverRoles = cfg[UserType.RESTAURANT].receiverRoles;
    }

    const receivers = await this.resolveReceivers(
      receiverType,
      receiverRoles,
      targetKind === 'RESTAURANT' ? restaurantId : null,
      caller.id,
    );
    if (receivers.length === 0) {
      throw new BadRequestException('Aucun destinataire disponible pour cet appel');
    }
    return this.createAndRing(caller, {
      targetKind,
      targetUserId: null,
      targetRestaurantId: targetKind === 'RESTAURANT' ? restaurantId : null,
      receivers,
      targetLabel,
    });
  }

  /** Crée la room Lunion, persiste l'appel, et fait sonner tous les receveurs. */
  private async createAndRing(
    caller: User,
    opts: {
      targetKind: 'RESTAURANT' | 'CALL_CENTER' | 'USER';
      targetUserId: string | null;
      targetRestaurantId: string | null;
      receivers: { id: string; fullname: string }[];
      targetLabel: string;
    },
  ) {
    let room: { slug: string; name: string };
    try {
      room = await this.lunion.createRoom(
        `cn-call-${caller.id.slice(0, 8)}`,
        `Appel ${caller.fullname} → ${opts.targetLabel}`,
      );
    } catch (e) {
      this.logger.error(`createRoom échec: ${(e as Error).message}`);
      throw new BadRequestException("Impossible de créer la room d'appel");
    }
    const callerAccess = await this.lunion.createToken(
      room.slug,
      `user-${caller.id}`,
      caller.fullname,
    );

    const call = await this.prisma.call.create({
      data: {
        room_slug: room.slug,
        room_name: room.name,
        status: CallStatus.RINGING,
        caller_id: caller.id,
        caller_type: caller.type,
        target_kind: opts.targetKind,
        target_restaurant_id: opts.targetRestaurantId,
        target_user_id: opts.targetUserId,
        ringing_user_ids: opts.receivers.map((r) => r.id),
        rung_user_ids: opts.receivers.map((r) => r.id),
      },
    });

    let onlineCount = 0;
    for (const r of opts.receivers) {
      if (this.gateway.isUserOnline(r.id)) onlineCount++;
      this.gateway.emitToUser(r.id, 'user', CALL_EVENTS.INCOMING, {
        callId: call.id,
        room: room.slug,
        callerId: caller.id,
        callerName: caller.fullname,
        callerType: caller.type,
        targetKind: opts.targetKind,
        targetLabel: opts.targetLabel,
        startedAt: call.started_at,
      });
    }

    return {
      call,
      access: {
        room: room.slug,
        token: callerAccess.token,
        url: callerAccess.url,
        identity: callerAccess.identity ?? `user-${caller.id}`,
      },
      ringing: opts.receivers.length,
      online: onlineCount,
      targetLabel: opts.targetLabel,
    };
  }

  /**
   * Un receveur décroche. Claim ATOMIQUE sur `status` (RINGING → ONGOING) : seul
   * le premier gagne, les autres reçoivent `call:taken`. L'appelant reçoit `call:accepted`.
   */
  async answer(callId: string, user: User) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    if (!call.ringing_user_ids.includes(user.id)) {
      throw new ForbiddenException("Cet appel ne vous est pas destiné");
    }

    const claimed = await this.prisma.call.updateMany({
      where: { id: callId, status: CallStatus.RINGING },
      data: {
        status: CallStatus.ONGOING,
        answered_by_id: user.id,
        answered_at: new Date(),
      },
    });
    if (claimed.count === 0) {
      // Déjà pris par un autre receveur, ou annulé entre-temps.
      return { taken: true };
    }

    const access = await this.lunion.createToken(call.room_slug, `user-${user.id}`, user.fullname);

    // L'appelant apprend qui a décroché
    this.gateway.emitToUser(call.caller_id, 'user', CALL_EVENTS.ACCEPTED, {
      callId: call.id,
      answeredById: user.id,
      answeredByName: user.fullname,
    });

    // Les autres receveurs arrêtent de sonner
    for (const rid of call.ringing_user_ids) {
      if (rid !== user.id) {
        this.gateway.emitToUser(rid, 'user', CALL_EVENTS.TAKEN, {
          callId: call.id,
          takenBy: user.fullname,
        });
      }
    }

    return {
      taken: false,
      call: { id: call.id, room_slug: call.room_slug },
      access: {
        room: call.room_slug,
        token: access.token,
        url: access.url,
        identity: access.identity ?? `user-${user.id}`,
      },
    };
  }

  /**
   * Un receveur refuse : on le retire de la sonnerie (retrait ATOMIQUE via
   * `array_remove`, sûr en cas de refus simultanés). S'il ne reste personne,
   * l'appel devient MISSED et l'appelant reçoit `call:ended` (raison no-answer).
   */
  async reject(callId: string, user: User) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    if (!call.rung_user_ids.includes(user.id)) {
      throw new ForbiddenException("Cet appel ne vous est pas destiné");
    }
    if (call.status !== CallStatus.RINGING) return { status: call.status };

    const rows = await this.prisma.$queryRaw<{ ringing_user_ids: string[] }[]>`
      UPDATE "calls"
      SET "ringing_user_ids" = array_remove("ringing_user_ids", ${user.id}),
          "updated_at" = NOW()
      WHERE "id" = ${callId}::uuid AND "status" = 'RINGING'
      RETURNING "ringing_user_ids"`;
    if (rows.length === 0) return { status: CallStatus.ONGOING }; // pris/annulé entre-temps

    if (rows[0].ringing_user_ids.length === 0) {
      // Dernier refus → appel manqué (idempotent : conditionné sur RINGING).
      await this.prisma.call.updateMany({
        where: { id: callId, status: CallStatus.RINGING },
        data: { status: CallStatus.MISSED, ended_at: new Date() },
      });
      this.gateway.emitToUser(call.caller_id, 'user', CALL_EVENTS.ENDED, {
        callId: call.id,
        reason: 'no-answer',
      });
      void this.lunion.deleteRoom(call.room_slug);
      return { status: CallStatus.MISSED };
    }

    // Info non bloquante à l'appelant
    this.gateway.emitToUser(call.caller_id, 'user', CALL_EVENTS.REJECTED, {
      callId: call.id,
      rejectedBy: user.fullname,
    });
    return { status: CallStatus.RINGING };
  }

  /**
   * Raccrocher : gère l'annulation (avant décrochage → CANCELLED) et la fin
   * normale (en cours → ENDED). Notifie l'autre partie / stoppe les sonneries.
   * Réservé aux participants (appelant, receveur sonné, décrocheur) ou admin.
   */
  async hangup(callId: string, user: User) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    this.assertParticipant(call, user);
    if (TERMINAL_STATUSES.includes(call.status)) return { status: call.status };

    const isCaller = call.caller_id === user.id;

    if (call.status === CallStatus.RINGING) {
      // Un receveur qui « raccroche » pendant la sonnerie = un refus.
      if (!isCaller) return this.reject(callId, user);

      // Annulation par l'appelant avant tout décrochage (claim atomique :
      // si un receveur décroche au même instant, on bascule en fin normale).
      const cancelled = await this.prisma.call.updateMany({
        where: { id: callId, status: CallStatus.RINGING },
        data: { status: CallStatus.CANCELLED, ended_at: new Date() },
      });
      if (cancelled.count === 0) {
        const fresh = await this.prisma.call.findUnique({ where: { id: callId } });
        if (fresh && fresh.status === CallStatus.ONGOING) {
          return this.endOngoing(fresh, user);
        }
        return { status: fresh?.status ?? CallStatus.CANCELLED };
      }
      for (const rid of call.ringing_user_ids) {
        this.gateway.emitToUser(rid, 'user', CALL_EVENTS.CANCELLED, { callId: call.id });
      }
      void this.lunion.deleteRoom(call.room_slug);
      return { status: CallStatus.CANCELLED };
    }

    return this.endOngoing(call, user);
  }

  /** Fin normale d'un appel ONGOING (idempotent : conditionné sur le statut). */
  private async endOngoing(call: { id: string; room_slug: string; caller_id: string; answered_by_id: string | null }, user: User) {
    const ended = await this.prisma.call.updateMany({
      where: { id: call.id, status: CallStatus.ONGOING },
      data: { status: CallStatus.ENDED, ended_at: new Date() },
    });
    if (ended.count > 0) {
      const otherId = call.caller_id === user.id ? call.answered_by_id : call.caller_id;
      if (otherId) {
        this.gateway.emitToUser(otherId, 'user', CALL_EVENTS.ENDED, {
          callId: call.id,
          reason: 'hangup',
        });
      }
      void this.lunion.deleteRoom(call.room_slug);
    }
    return { status: CallStatus.ENDED };
  }

  /** L'utilisateur est-il partie prenante de cet appel ? (sinon 403) */
  private assertParticipant(
    call: { caller_id: string; answered_by_id: string | null; rung_user_ids: string[] },
    user: User,
  ) {
    const ok =
      call.caller_id === user.id ||
      call.answered_by_id === user.id ||
      call.rung_user_ids.includes(user.id) ||
      user.role === UserRole.ADMIN;
    if (!ok) throw new ForbiddenException("Cet appel ne vous concerne pas");
  }

  /**
   * Statut d'un appel — filet de sécurité de synchronisation pour les clients
   * (polling) : l'UI converge même si un événement socket s'est perdu.
   */
  async getStatus(callId: string, user: User) {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: { answered_by: { select: { id: true, fullname: true } } },
    });
    if (!call) throw new NotFoundException('Appel introuvable');
    this.assertParticipant(call, user);
    return {
      id: call.id,
      status: call.status,
      answered_by: call.answered_by,
      started_at: call.started_at,
      answered_at: call.answered_at,
      ended_at: call.ended_at,
    };
  }

  /**
   * MON appel actif (repris au chargement de page) : un rechargement du
   * backoffice perd l'état en mémoire alors que l'appel est toujours EN COURS
   * côté serveur. On renvoie l'appel + un jeton Lunion FRAIS pour re-rejoindre
   * la room. Couvre : appel ONGOING (appelant ou décrocheur) et appel sortant
   * encore en sonnerie (< 90 s). Renvoie null si rien à restaurer.
   */
  async getActiveForMe(user: User) {
    const include = {
      caller: { select: { id: true, fullname: true } },
      answered_by: { select: { id: true, fullname: true } },
      target_restaurant: { select: { name: true } },
      target_user: { select: { fullname: true } },
    } as const;

    let call = await this.prisma.call.findFirst({
      where: {
        status: CallStatus.ONGOING,
        OR: [{ caller_id: user.id }, { answered_by_id: user.id }],
      },
      orderBy: { started_at: 'desc' },
      include,
    });

    // Appel sortant encore en sonnerie (l'appelant a rechargé pendant que ça sonne).
    if (!call) {
      call = await this.prisma.call.findFirst({
        where: {
          status: CallStatus.RINGING,
          caller_id: user.id,
          started_at: { gte: new Date(Date.now() - 90_000) },
        },
        orderBy: { started_at: 'desc' },
        include,
      });
    }
    if (!call) return null;

    const isCaller = call.caller_id === user.id;
    const targetLabel =
      call.target_kind === 'CALL_CENTER'
        ? 'Call Center'
        : call.target_kind === 'USER'
          ? (call.target_user?.fullname ?? 'Personne')
          : (call.target_restaurant?.name ?? 'Restaurant');
    const peerLabel = isCaller
      ? (call.answered_by?.fullname ?? targetLabel)
      : (call.caller?.fullname ?? 'Appelant');

    const access = await this.lunion.createToken(
      call.room_slug,
      `user-${user.id}`,
      user.fullname,
    );

    return {
      callId: call.id,
      direction: isCaller ? 'outgoing' : 'incoming',
      phase: call.status === CallStatus.ONGOING ? 'connected' : 'calling',
      peerLabel,
      access: {
        room: call.room_slug,
        token: access.token,
        url: access.url,
        identity: access.identity ?? `user-${user.id}`,
      },
    };
  }

  /**
   * Appels qui sonnent ENCORE pour moi (repris à la connexion / au chargement
   * de page : couvre un `call:incoming` émis pendant que j'étais déconnecté).
   */
  async listRingingForMe(user: User) {
    const calls = await this.prisma.call.findMany({
      where: {
        status: CallStatus.RINGING,
        ringing_user_ids: { has: user.id },
        started_at: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { started_at: 'desc' },
      include: {
        caller: { select: { id: true, fullname: true, type: true } },
        target_restaurant: { select: { name: true } },
        target_user: { select: { fullname: true } },
      },
    });
    return calls.map((c) => ({
      callId: c.id,
      room: c.room_slug,
      callerId: c.caller_id,
      callerName: c.caller?.fullname ?? 'Appelant',
      callerType: c.caller_type,
      targetKind: c.target_kind,
      targetLabel:
        c.target_kind === 'CALL_CENTER'
          ? 'Call Center'
          : c.target_kind === 'USER'
            ? (c.target_user?.fullname ?? 'Personne')
            : (c.target_restaurant?.name ?? 'Restaurant'),
      startedAt: c.started_at,
    }));
  }

  /** Historique récent visible par l'utilisateur (émis, reçus, ou ciblant son resto). */
  async history(user: User, limit = 30) {
    const or: Prisma.CallWhereInput[] = [
      { caller_id: user.id },
      { answered_by_id: user.id },
      // Liste IMMUABLE des sonnés : les manqués restent visibles même après
      // refus/annulation (ringing_user_ids mute au fil des refus).
      { rung_user_ids: { has: user.id } },
    ];
    if (user.restaurant_id) or.push({ target_restaurant_id: user.restaurant_id });

    return this.prisma.call.findMany({
      where: { OR: or },
      orderBy: { started_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: {
        caller: {
          select: {
            id: true,
            fullname: true,
            image: true,
            type: true,
            restaurant: { select: { id: true, name: true } },
          },
        },
        answered_by: { select: { id: true, fullname: true } },
        target_restaurant: { select: { id: true, name: true } },
        target_user: { select: { id: true, fullname: true } },
      },
    });
  }

  /** Résout les receveurs éligibles (actifs, du bon type/rôle, hors appelant). */
  private async resolveReceivers(
    receiverType: UserType,
    receiverRoles: UserRole[],
    restaurantId: string | null,
    callerId: string,
  ) {
    const where: Prisma.UserWhereInput = {
      entity_status: EntityStatus.ACTIVE,
      type: receiverType,
      id: { not: callerId },
    };
    if (receiverRoles.length > 0) where.role = { in: receiverRoles };
    if (receiverType === UserType.RESTAURANT && restaurantId) {
      where.restaurant_id = restaurantId;
    }
    return this.prisma.user.findMany({
      where,
      select: { id: true, fullname: true },
    });
  }

  /** Webhook Lunion : backstop de clôture sur `session.ended`. */
  async handleWebhook(event: string, payload: { room?: string } | undefined) {
    if (event === 'session.ended' && payload?.room) {
      await this.prisma.call.updateMany({
        where: {
          room_slug: payload.room,
          status: { in: [CallStatus.RINGING, CallStatus.ONGOING] },
        },
        data: { status: CallStatus.ENDED, ended_at: new Date() },
      });
    }
  }
}
