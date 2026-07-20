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
    const config = await this.config.getForCaller(caller.type);
    if (!config.canCall) {
      throw new ForbiddenException("Votre profil n'est pas autorisé à passer des appels");
    }

    // Résolution de la cible + label
    let targetRestaurantId: string | null = null;
    let targetLabel: string;
    if (config.targetKind === 'RESTAURANT') {
      if (!dto.restaurantId) {
        throw new BadRequestException('restaurantId requis pour appeler un restaurant');
      }
      const resto = await this.prisma.restaurant.findUnique({
        where: { id: dto.restaurantId },
        select: { id: true, name: true },
      });
      if (!resto) throw new NotFoundException('Restaurant introuvable');
      targetRestaurantId = resto.id;
      targetLabel = resto.name;
    } else {
      targetLabel = 'Call Center';
    }

    const receivers = await this.resolveReceivers(
      config.receiverType,
      config.receiverRoles,
      targetRestaurantId,
      caller.id,
    );
    if (receivers.length === 0) {
      throw new BadRequestException('Aucun destinataire disponible pour cet appel');
    }

    // Room Lunion + token appelant
    let room: { slug: string; name: string };
    try {
      room = await this.lunion.createRoom(
        `cn-call-${caller.id.slice(0, 8)}-${caller.type.toLowerCase()}`,
        `Appel ${caller.fullname} → ${targetLabel}`,
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
        target_kind: config.targetKind,
        target_restaurant_id: targetRestaurantId,
        ringing_user_ids: receivers.map((r) => r.id),
      },
    });

    // Sonnerie : émettre l'appel entrant à chaque receveur
    let onlineCount = 0;
    for (const r of receivers) {
      if (this.gateway.isUserOnline(r.id)) onlineCount++;
      this.gateway.emitToUser(r.id, 'user', CALL_EVENTS.INCOMING, {
        callId: call.id,
        room: room.slug,
        callerId: caller.id,
        callerName: caller.fullname,
        callerType: caller.type,
        targetKind: config.targetKind,
        targetLabel,
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
      ringing: receivers.length,
      online: onlineCount,
      targetLabel,
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
   * Un receveur refuse : on le retire de la sonnerie. S'il ne reste personne,
   * l'appel devient MISSED et l'appelant reçoit `call:ended` (raison no-answer).
   */
  async reject(callId: string, user: User) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    if (call.status !== CallStatus.RINGING) return { status: call.status };

    const remaining = call.ringing_user_ids.filter((id) => id !== user.id);

    if (remaining.length === 0) {
      await this.prisma.call.updateMany({
        where: { id: callId, status: CallStatus.RINGING },
        data: { status: CallStatus.MISSED, ringing_user_ids: [], ended_at: new Date() },
      });
      this.gateway.emitToUser(call.caller_id, 'user', CALL_EVENTS.ENDED, {
        callId: call.id,
        reason: 'no-answer',
      });
      void this.lunion.deleteRoom(call.room_slug);
      return { status: CallStatus.MISSED };
    }

    await this.prisma.call.update({
      where: { id: callId },
      data: { ringing_user_ids: remaining },
    });
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
   */
  async hangup(callId: string, user: User) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    if (TERMINAL_STATUSES.includes(call.status)) return { status: call.status };

    const isCaller = call.caller_id === user.id;

    if (call.status === CallStatus.RINGING) {
      // Annulation par l'appelant avant tout décrochage
      await this.prisma.call.updateMany({
        where: { id: callId, status: CallStatus.RINGING },
        data: { status: CallStatus.CANCELLED, ringing_user_ids: [], ended_at: new Date() },
      });
      for (const rid of call.ringing_user_ids) {
        this.gateway.emitToUser(rid, 'user', CALL_EVENTS.CANCELLED, { callId: call.id });
      }
      void this.lunion.deleteRoom(call.room_slug);
      return { status: CallStatus.CANCELLED };
    }

    // ONGOING → fin normale
    await this.prisma.call.update({
      where: { id: callId },
      data: { status: CallStatus.ENDED, ended_at: new Date() },
    });
    const otherId = isCaller ? call.answered_by_id : call.caller_id;
    if (otherId) {
      this.gateway.emitToUser(otherId, 'user', CALL_EVENTS.ENDED, {
        callId: call.id,
        reason: 'hangup',
      });
    }
    void this.lunion.deleteRoom(call.room_slug);
    return { status: CallStatus.ENDED };
  }

  /** Historique récent visible par l'utilisateur (émis, reçus, ou ciblant son resto). */
  async history(user: User, limit = 30) {
    const or: Prisma.CallWhereInput[] = [
      { caller_id: user.id },
      { answered_by_id: user.id },
      { ringing_user_ids: { has: user.id } },
    ];
    if (user.restaurant_id) or.push({ target_restaurant_id: user.restaurant_id });

    return this.prisma.call.findMany({
      where: { OR: or },
      orderBy: { started_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: {
        caller: { select: { id: true, fullname: true, image: true, type: true } },
        answered_by: { select: { id: true, fullname: true } },
        target_restaurant: { select: { id: true, name: true } },
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
