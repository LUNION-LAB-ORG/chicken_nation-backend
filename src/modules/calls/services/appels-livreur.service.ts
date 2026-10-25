import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CallStatus,
  CourseStatut,
  Deliverer,
  EntityStatus,
  Prisma,
  User,
  UserType,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import {
  APPELANT_LIVREUR,
  APPEL_FANTOME_MS,
  CALLS_LIVREURS_ACTIF_KEY,
  CALL_EVENTS,
  CIBLE_LIVREUR,
  CODES_APPEL_LIVREUR,
  LIBELLE_SERVICE_CLIENT,
  MARGE_SONNERIE_LIVREUR_MS,
  RaisonFinAppel,
  SONNERIE_LIVREUR_MS,
  TELEPHONE_SERVICE_CLIENT,
  TTL_JETON_LIVREUR_S,
} from '../constants/calls.constants';
import { StartCallDto } from '../dto/start-call.dto';
import { StartDelivererCallDto } from '../dto/start-deliverer-call.dto';
import {
  appelantLivreur,
  lireAppelsLivreursActifs,
  nomLivreur,
  peutAppelerLivreur,
  phasePourLivreur,
  SELECT_LIVREUR_APPEL,
} from '../helpers/appels-livreur.rules';
import { CallsConfigService } from './calls-config.service';
import { CallsService } from './calls.service';
import { LunionMeetService } from './lunion-meet.service';

/** Le livreur connecté, tel que JwtDelivererAuthGuard le pose sur la requête. */
export type LivreurConnecte = Pick<
  Deliverer,
  'id' | 'first_name' | 'last_name' | 'phone' | 'restaurant_id'
>;

const STATUTS_FINAUX: CallStatus[] = [
  CallStatus.ENDED,
  CallStatus.MISSED,
  CallStatus.CANCELLED,
  CallStatus.FAILED,
];

/** Course en cours d'un livreur : acceptée, au restaurant ou en livraison. */
const COURSE_EN_COURS: CourseStatut[] = [
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];

/** Marge après la sonnerie avant qu'un appel encore « RINGING » soit tenu pour manqué (serveur redémarré). */
const MARGE_SONNERIE_MS = MARGE_SONNERIE_LIVREUR_MS;

const NUMERO_LISIBLE = '27 21 71 21 30';

/**
 * Appels dans l'appli entre les livreurs et le service client (demande du 24/10).
 *
 *  - Le livreur appelle le service client (POST /calls/deliverer) : sonnerie
 *    de groupe des receveurs d'un appel vers le centre d'appels (config de
 *    routage existante), premier agent qui décroche gagne (claim atomique de
 *    CallsService.answer).
 *  - Le service client appelle un livreur (POST /calls, `targetKind:
 *    'DELIVERER'`) : l'appli du livreur sonne (`call:incoming` dans
 *    `deliverer_{id}` + notification `appel_entrant`), il décroche, refuse ou
 *    laisse sonner (manqué au bout de 45 s).
 *
 * Un livreur n'agit que sur SES appels : chaque écriture est conditionnée sur
 * son identifiant (appelant ou appelé), jamais sur le seul identifiant de
 * l'appel. Il ne reçoit qu'un jeton de participant Lunion de 4 h, jamais la
 * clé du service. Ses actions vont au journal d'audit (l'intercepteur ne
 * journalise que le personnel).
 *
 * Réglage `calls.livreurs_actif` à 0 : appeler et décrocher sont refusés
 * (`APPELS_LIVREURS_DESACTIVES`), GET /calls/deliverer/active répond
 * `actif: false`. Raccrocher et refuser restent possibles : on ne bloque
 * jamais la fin d'un appel.
 */
@Injectable()
export class AppelsLivreurService implements OnModuleDestroy {
  private readonly logger = new Logger(AppelsLivreurService.name);
  /** Minuteries de sonnerie (appel manqué au bout de 45 s), par appel. */
  private readonly sonneries = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly lunion: LunionMeetService,
    private readonly config: CallsConfigService,
    private readonly calls: CallsService,
    private readonly gateway: AppGateway,
    private readonly settings: SettingsService,
    private readonly push: DelivererPushService,
    private readonly audit: AuditService,
  ) {}

  onModuleDestroy() {
    for (const minuterie of this.sonneries.values()) clearTimeout(minuterie);
    this.sonneries.clear();
  }

  // ============================================================
  // RÉGLAGE
  // ============================================================

  /** Réglage `calls.livreurs_actif` (actif par défaut, et si la base ne répond pas). */
  async actifs(): Promise<boolean> {
    try {
      return lireAppelsLivreursActifs(await this.settings.get(CALLS_LIVREURS_ACTIF_KEY));
    } catch (e) {
      this.logger.warn(`Réglage ${CALLS_LIVREURS_ACTIF_KEY} illisible, appels gardés actifs : ${(e as Error).message}`);
      return true;
    }
  }

  private async exigerActifs(pour: 'livreur' | 'personnel') {
    if (await this.actifs()) return;
    throw new ForbiddenException(
      pour === 'livreur'
        ? {
            message: `L'appel dans l'appli est coupé pour l'instant. Appelle le ${NUMERO_LISIBLE}.`,
            code: CODES_APPEL_LIVREUR.DESACTIVES,
            telephone: TELEPHONE_SERVICE_CLIENT,
          }
        : {
            message: 'Les appels avec les livreurs sont coupés.',
            code: CODES_APPEL_LIVREUR.DESACTIVES,
          },
    );
  }

  // ============================================================
  // LE LIVREUR APPELLE LE SERVICE CLIENT
  // ============================================================

  async appelerServiceClient(livreur: LivreurConnecte, dto: StartDelivererCallDto) {
    await this.exigerActifs('livreur');
    await this.balayer();

    const enCours = await this.appelActifDuLivreur(livreur.id);
    if (enCours) {
      throw new ConflictException({
        message: 'Tu as déjà un appel en cours.',
        code: CODES_APPEL_LIVREUR.EN_COURS,
        callId: enCours.id,
      });
    }

    const fiche =
      (await this.prisma.deliverer.findUnique({
        where: { id: livreur.id },
        select: SELECT_LIVREUR_APPEL,
      })) ?? { ...livreur, restaurant: null };
    const { course, orderId } = await this.contexteCourse(livreur.id, dto);

    // Receveurs d'un appel vers le centre d'appels : ceux de la config de
    // routage (appelant RESTAURANT → rôle CALL_CENTER par défaut).
    const regle = (await this.config.getConfig())[UserType.RESTAURANT];
    const receveurs = await this.calls.resolveReceivers(
      regle.receiverType,
      regle.receiverRoles,
      null,
      livreur.id,
    );
    if (receveurs.length === 0) {
      throw new ServiceUnavailableException({
        message: `Personne au service client pour l'instant. Appelle le ${NUMERO_LISIBLE}.`,
        code: CODES_APPEL_LIVREUR.AUCUN_AGENT,
        telephone: TELEPHONE_SERVICE_CLIENT,
      });
    }

    const nom = nomLivreur(fiche);
    const { room, access } = await this.ouvrirSalle(
      `cn-livreur-${livreur.id.slice(0, 8)}`,
      `Appel ${nom} → ${LIBELLE_SERVICE_CLIENT}`,
      { identity: `livreur-${livreur.id}`, name: nom, ttl: TTL_JETON_LIVREUR_S },
      'livreur',
    );

    const call = await this.prisma.call.create({
      data: {
        room_slug: room.slug,
        room_name: room.name,
        status: CallStatus.RINGING,
        caller_id: null,
        caller_type: null,
        caller_deliverer_id: livreur.id,
        target_kind: 'CALL_CENTER',
        ringing_user_ids: receveurs.map((r) => r.id),
        rung_user_ids: receveurs.map((r) => r.id),
        course_id: course?.id ?? null,
        order_id: orderId,
      },
    });

    const appelant = appelantLivreur(fiche, course);
    let online = 0;
    for (const r of receveurs) {
      if (this.gateway.isUserOnline(r.id)) online++;
      this.gateway.emitToUser(r.id, 'user', CALL_EVENTS.INCOMING, {
        callId: call.id,
        room: room.slug,
        callerId: livreur.id,
        callerName: nom,
        callerType: APPELANT_LIVREUR,
        targetKind: 'CALL_CENTER',
        targetLabel: 'Call Center',
        startedAt: call.started_at,
        livreur: appelant,
      });
    }
    this.armerSonnerie(call.id);
    this.journaliser(livreur, nom, {
      action: 'CREATE',
      callId: call.id,
      path: '/calls/deliverer',
      status: 201,
      resume: `Livreur : appel au call center (${receveurs.length} poste(s) sonnent)`,
      details: { courseId: course?.id ?? null, orderId },
    });

    return {
      call: {
        id: call.id,
        status: call.status,
        started_at: call.started_at,
        course_id: call.course_id,
        order_id: call.order_id,
      },
      access,
      ringing: receveurs.length,
      online,
      targetLabel: LIBELLE_SERVICE_CLIENT,
    };
  }

  // ============================================================
  // LE SERVICE CLIENT APPELLE UN LIVREUR
  // ============================================================

  async appelerLivreur(caller: User, dto: StartCallDto) {
    if (!peutAppelerLivreur(caller.role)) {
      throw new ForbiddenException("Votre profil n'est pas autorisé à appeler un livreur");
    }
    await this.exigerActifs('personnel');
    if (!dto.deliverer_id) throw new BadRequestException('deliverer_id requis');

    const livreur = await this.prisma.deliverer.findFirst({
      where: { id: dto.deliverer_id, entity_status: EntityStatus.ACTIVE },
      select: SELECT_LIVREUR_APPEL,
    });
    if (!livreur) throw new NotFoundException('Livreur introuvable');

    await this.balayer();
    if (await this.appelActifDuLivreur(livreur.id)) {
      throw new ConflictException({
        message: 'Ce livreur est déjà en appel.',
        code: CODES_APPEL_LIVREUR.EN_COURS,
      });
    }

    const course = await this.courseEnCours(livreur.id);
    const nom = nomLivreur(livreur);
    const { room, access } = await this.ouvrirSalle(
      `cn-call-${caller.id.slice(0, 8)}`,
      `Appel ${caller.fullname} → ${nom}`,
      { identity: `user-${caller.id}`, name: caller.fullname },
      'personnel',
    );

    const call = await this.prisma.call.create({
      data: {
        room_slug: room.slug,
        room_name: room.name,
        status: CallStatus.RINGING,
        caller_id: caller.id,
        caller_type: caller.type,
        target_kind: CIBLE_LIVREUR,
        target_deliverer_id: livreur.id,
        ringing_user_ids: [],
        rung_user_ids: [],
        course_id: course?.id ?? null,
      },
    });

    this.gateway.emitToDeliverer(livreur.id, CALL_EVENTS.INCOMING, {
      callId: call.id,
      room: room.slug,
      callerName: caller.fullname,
      callerLabel: LIBELLE_SERVICE_CLIENT,
      startedAt: call.started_at,
      expiresAt: new Date(call.started_at.getTime() + SONNERIE_LIVREUR_MS),
    });
    // Appli fermée ou en arrière-plan : la notification le prévient.
    this.push.notifyAppelEntrant({ delivererId: livreur.id, callId: call.id });
    this.armerSonnerie(call.id);

    // Présence inconnue (Redis muet) : on ne prétend pas qu'il est hors ligne.
    const connecte = await this.gateway.livreurConnecte(livreur.id);
    return {
      call,
      access,
      ringing: 1,
      online: connecte === false ? 0 : 1,
      targetLabel: nom,
      livreur: appelantLivreur(livreur, course),
    };
  }

  // ============================================================
  // DÉCROCHER, REFUSER, RACCROCHER (côté livreur)
  // ============================================================

  /**
   * Le livreur décroche un appel du service client. Le jeton est demandé avant
   * le claim (Lunion muet : l'appel continue de sonner, rien n'est perdu), puis
   * RINGING → ONGOING conditionné sur l'appel ET sur le livreur appelé.
   */
  async decrocher(livreur: LivreurConnecte, callId: string) {
    await this.exigerActifs('livreur');
    const call = await this.appelDuLivreur(callId, livreur.id, 'appele');
    if (call.status !== CallStatus.RINGING) return { taken: true, status: call.status };

    const nom = nomLivreur(livreur);
    let jeton: Awaited<ReturnType<LunionMeetService['createToken']>>;
    try {
      jeton = await this.lunion.createToken(call.room_slug, `livreur-${livreur.id}`, nom, TTL_JETON_LIVREUR_S);
    } catch (e) {
      this.logger.error(`Jeton Lunion refusé pour le livreur ${livreur.id.slice(0, 8)} : ${(e as Error).message}`);
      throw this.indisponible('livreur');
    }

    const pris = await this.prisma.call.updateMany({
      where: { id: callId, status: CallStatus.RINGING, target_deliverer_id: livreur.id },
      data: { status: CallStatus.ONGOING, answered_at: new Date() },
    });
    if (pris.count === 0) {
      // Annulé par l'agent ou manqué entre-temps : le jeton n'est jamais rendu.
      const frais = await this.prisma.call.findUnique({ where: { id: callId }, select: { status: true } });
      return { taken: true, status: frais?.status ?? call.status };
    }
    this.desarmerSonnerie(callId);

    this.calls.prevenirAppelant(call, CALL_EVENTS.ACCEPTED, {
      callId: call.id,
      answeredById: livreur.id,
      answeredByName: nom,
    });
    // Ses autres appareils arrêtent de sonner (celui qui a décroché l'ignore).
    this.gateway.emitToDeliverer(livreur.id, CALL_EVENTS.TAKEN, { callId: call.id, takenBy: nom });
    this.journaliser(livreur, nom, {
      action: 'UPDATE',
      callId,
      path: `/calls/deliverer/${callId}/answer`,
      status: 201,
      resume: 'Livreur : a décroché un appel du call center',
    });

    return {
      taken: false,
      call: { id: call.id, room_slug: call.room_slug },
      access: {
        room: call.room_slug,
        token: jeton.token,
        url: jeton.url,
        identity: jeton.identity ?? `livreur-${livreur.id}`,
      },
    };
  }

  /** Le livreur refuse un appel du service client : appel manqué, l'agent reçoit `call:ended` (`rejected`). */
  async refuser(livreur: LivreurConnecte, callId: string) {
    const call = await this.appelDuLivreur(callId, livreur.id, 'appele');
    if (call.status !== CallStatus.RINGING) return { status: call.status };

    const refuse = await this.prisma.call.updateMany({
      where: { id: callId, status: CallStatus.RINGING, target_deliverer_id: livreur.id },
      data: { status: CallStatus.MISSED, ended_at: new Date() },
    });
    if (refuse.count === 0) {
      const frais = await this.prisma.call.findUnique({ where: { id: callId }, select: { status: true } });
      return { status: frais?.status ?? call.status };
    }
    this.desarmerSonnerie(callId);

    const fin = { callId: call.id, reason: 'rejected' satisfies RaisonFinAppel };
    this.calls.prevenirAppelant(call, CALL_EVENTS.ENDED, fin);
    this.gateway.emitToDeliverer(livreur.id, CALL_EVENTS.ENDED, fin);
    void this.lunion.deleteRoom(call.room_slug);
    this.journaliser(livreur, nomLivreur(livreur), {
      action: 'UPDATE',
      callId,
      path: `/calls/deliverer/${callId}/reject`,
      status: 201,
      resume: 'Livreur : a refusé un appel du call center',
    });
    return { status: CallStatus.MISSED };
  }

  /**
   * Le livreur raccroche : annule son appel qui sonne encore (CANCELLED, les
   * agents arrêtent de sonner), refuse un appel du service client qui sonne,
   * ou termine l'appel en cours (ENDED, l'autre côté reçoit `call:ended`).
   */
  async raccrocher(livreur: LivreurConnecte, callId: string) {
    const call = await this.appelDuLivreur(callId, livreur.id, 'partie');
    if (STATUTS_FINAUX.includes(call.status)) return { status: call.status };

    const nom = nomLivreur(livreur);
    const journal = (resume: string) =>
      this.journaliser(livreur, nom, {
        action: 'UPDATE',
        callId,
        path: `/calls/deliverer/${callId}/hangup`,
        status: 201,
        resume,
      });

    if (call.status === CallStatus.RINGING) {
      if (call.caller_deliverer_id !== livreur.id) return this.refuser(livreur, callId);

      const annule = await this.prisma.call.updateMany({
        where: { id: callId, status: CallStatus.RINGING, caller_deliverer_id: livreur.id },
        data: { status: CallStatus.CANCELLED, ended_at: new Date() },
      });
      if (annule.count === 0) {
        // Un agent a décroché au même instant : fin normale.
        const frais = await this.prisma.call.findUnique({ where: { id: callId } });
        if (frais && frais.status === CallStatus.ONGOING) {
          journal('Livreur : a raccroché');
          return this.calls.terminerAppelEnCours(frais, { type: 'deliverer', id: livreur.id });
        }
        return { status: frais?.status ?? CallStatus.CANCELLED };
      }
      this.desarmerSonnerie(callId);
      for (const rid of call.ringing_user_ids) {
        this.gateway.emitToUser(rid, 'user', CALL_EVENTS.CANCELLED, { callId: call.id });
      }
      void this.lunion.deleteRoom(call.room_slug);
      journal('Livreur : a annulé son appel au call center avant la réponse');
      return { status: CallStatus.CANCELLED };
    }

    journal('Livreur : a raccroché');
    return this.calls.terminerAppelEnCours(call, { type: 'deliverer', id: livreur.id });
  }

  // ============================================================
  // MON APPEL (reprise au lancement de l'appli)
  // ============================================================

  /**
   * L'appel du livreur qui sonne ou qui est en cours, avec un jeton frais
   * quand il peut (re)joindre la salle : son appel qui sonne au service
   * client, ou un appel en ligne. Un appel du service client qui sonne n'a pas
   * de jeton : il faut décrocher (POST /calls/deliverer/:id/answer).
   */
  async monAppel(livreur: LivreurConnecte) {
    const base = { telephone: TELEPHONE_SERVICE_CLIENT };
    if (!(await this.actifs())) return { actif: false, ...base, call: null, access: null };
    await this.balayer();

    const call = await this.appelActifDuLivreur(livreur.id);
    if (!call) return { actif: true, ...base, call: null, access: null };

    const { direction, phase } = phasePourLivreur(call, livreur.id);
    let access: { room: string; token: string; url: string; identity: string } | null = null;
    if (phase !== 'ringing') {
      try {
        const jeton = await this.lunion.createToken(
          call.room_slug,
          `livreur-${livreur.id}`,
          nomLivreur(livreur),
          TTL_JETON_LIVREUR_S,
        );
        access = {
          room: call.room_slug,
          token: jeton.token,
          url: jeton.url,
          identity: jeton.identity ?? `livreur-${livreur.id}`,
        };
      } catch (e) {
        this.logger.warn(`Jeton de reprise refusé pour le livreur ${livreur.id.slice(0, 8)} : ${(e as Error).message}`);
      }
    }

    const agent = direction === 'outgoing' ? call.answered_by?.fullname : call.caller?.fullname;
    return {
      actif: true,
      ...base,
      call: {
        callId: call.id,
        status: call.status,
        direction,
        phase,
        peerLabel: LIBELLE_SERVICE_CLIENT,
        agentName: agent ?? null,
        startedAt: call.started_at,
        answeredAt: call.answered_at,
        expiresAt:
          call.status === CallStatus.RINGING
            ? new Date(call.started_at.getTime() + SONNERIE_LIVREUR_MS)
            : null,
        course_reference: call.course?.reference ?? null,
      },
      access,
    };
  }

  // ============================================================
  // SONNERIE : APPEL MANQUÉ AU BOUT DE 45 s
  // ============================================================

  private armerSonnerie(callId: string) {
    this.desarmerSonnerie(callId);
    const minuterie = setTimeout(() => {
      this.sonneries.delete(callId);
      void this.expirerSonnerie(callId).catch((e) =>
        this.logger.warn(`Fin de sonnerie de l'appel ${callId.slice(0, 8)} non traitée : ${(e as Error).message}`),
      );
    }, SONNERIE_LIVREUR_MS);
    minuterie.unref?.();
    this.sonneries.set(callId, minuterie);
  }

  private desarmerSonnerie(callId: string) {
    const minuterie = this.sonneries.get(callId);
    if (minuterie) clearTimeout(minuterie);
    this.sonneries.delete(callId);
  }

  /**
   * Personne n'a décroché : RINGING → MISSED (conditionné sur le statut : sans
   * effet si l'appel a été pris, refusé ou annulé entre-temps). L'appelant
   * reçoit `call:ended` (`no-answer`), ceux qui sonnaient encore arrêtent.
   * Renvoie `true` si l'appel est passé en manqué.
   */
  async expirerSonnerie(callId: string): Promise<boolean> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call || call.status !== CallStatus.RINGING) return false;

    const manque = await this.prisma.call.updateMany({
      where: { id: callId, status: CallStatus.RINGING },
      data: { status: CallStatus.MISSED, ended_at: new Date() },
    });
    if (manque.count === 0) return false;

    const fin = { callId: call.id, reason: 'no-answer' satisfies RaisonFinAppel };
    if (call.caller_deliverer_id) {
      // Le livreur appelait : il entend « pas de réponse », les agents arrêtent de sonner.
      this.gateway.emitToDeliverer(call.caller_deliverer_id, CALL_EVENTS.ENDED, fin);
      for (const rid of call.ringing_user_ids) {
        this.gateway.emitToUser(rid, 'user', CALL_EVENTS.CANCELLED, { callId: call.id });
      }
    }
    if (call.target_deliverer_id) {
      // Le service client appelait : l'agent est prévenu, l'appli du livreur arrête de sonner.
      this.calls.prevenirAppelant(call, CALL_EVENTS.ENDED, fin);
      this.gateway.emitToDeliverer(call.target_deliverer_id, CALL_EVENTS.ENDED, fin);
    }
    void this.lunion.deleteRoom(call.room_slug);
    return true;
  }

  // ============================================================
  // OUTILS
  // ============================================================

  /** Appels avec un livreur. */
  private avecUnLivreur(): Prisma.CallWhereInput {
    return { OR: [{ caller_deliverer_id: { not: null } }, { target_kind: CIBLE_LIVREUR }] };
  }

  /**
   * Filet après un redémarrage (minuteries perdues) : un appel avec un livreur
   * qui sonne depuis plus de 60 s est manqué, un appel en ligne depuis plus de
   * 4 h est terminé. Sans événement : chaque côté a sa propre minuterie.
   */
  private async balayer() {
    const maintenant = Date.now();
    await this.prisma.call.updateMany({
      where: {
        AND: [
          this.avecUnLivreur(),
          {
            status: CallStatus.RINGING,
            started_at: { lt: new Date(maintenant - SONNERIE_LIVREUR_MS - MARGE_SONNERIE_MS) },
          },
        ],
      },
      data: { status: CallStatus.MISSED, ended_at: new Date(maintenant) },
    });
    await this.prisma.call.updateMany({
      where: {
        AND: [
          this.avecUnLivreur(),
          { status: CallStatus.ONGOING, started_at: { lt: new Date(maintenant - APPEL_FANTOME_MS) } },
        ],
      },
      data: { status: CallStatus.ENDED, ended_at: new Date(maintenant) },
    });
  }

  /** L'appel du livreur (appelant ou appelé) qui sonne encore ou qui est en cours. */
  private async appelActifDuLivreur(delivererId: string) {
    const maintenant = Date.now();
    return this.prisma.call.findFirst({
      where: {
        AND: [
          { OR: [{ caller_deliverer_id: delivererId }, { target_deliverer_id: delivererId }] },
          {
            OR: [
              {
                status: CallStatus.RINGING,
                started_at: { gte: new Date(maintenant - SONNERIE_LIVREUR_MS - MARGE_SONNERIE_MS) },
              },
              {
                status: CallStatus.ONGOING,
                started_at: { gte: new Date(maintenant - APPEL_FANTOME_MS) },
              },
            ],
          },
        ],
      },
      orderBy: { started_at: 'desc' },
      include: {
        caller: { select: { fullname: true } },
        answered_by: { select: { fullname: true } },
        course: { select: { reference: true } },
      },
    });
  }

  /**
   * Appel du livreur, ou refus. `appele` : il doit être le livreur appelé
   * (décrocher, refuser) ; `partie` : appelant ou appelé (raccrocher). Un
   * autre livreur reçoit 403, quel que soit l'appel.
   */
  private async appelDuLivreur(callId: string, delivererId: string, role: 'appele' | 'partie') {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    const appele = call.target_deliverer_id === delivererId;
    const appelant = call.caller_deliverer_id === delivererId;
    if (role === 'appele' ? !appele : !(appele || appelant)) {
      throw new ForbiddenException('Cet appel ne te concerne pas');
    }
    return call;
  }

  /** Course en cours du livreur (la dernière acceptée). */
  private courseEnCours(delivererId: string) {
    return this.prisma.course.findFirst({
      where: { deliverer_id: delivererId, statut: { in: COURSE_EN_COURS } },
      orderBy: { assigned_at: 'desc' },
      select: { id: true, reference: true },
    });
  }

  /**
   * Course et commande dont parle le livreur : celles qu'il donne si elles
   * sont bien à lui (sinon ignorées), à défaut sa course en cours.
   */
  private async contexteCourse(delivererId: string, dto: StartDelivererCallDto) {
    let course: { id: string; reference: string } | null = null;
    let orderId: string | null = null;
    if (dto.course_id) {
      course = await this.prisma.course.findFirst({
        where: { id: dto.course_id, deliverer_id: delivererId },
        select: { id: true, reference: true },
      });
    }
    if (dto.order_id) {
      const livraison = await this.prisma.delivery.findFirst({
        where: { order_id: dto.order_id, course: { deliverer_id: delivererId } },
        select: { order_id: true, course: { select: { id: true, reference: true } } },
      });
      if (livraison) {
        orderId = livraison.order_id;
        course ??= livraison.course;
      }
    }
    course ??= await this.courseEnCours(delivererId);
    return { course, orderId };
  }

  /** Salle Lunion et jeton de l'appelant. Lunion muet : 503 `APPELS_INDISPONIBLES`, salle supprimée. */
  private async ouvrirSalle(
    nom: string,
    description: string,
    participant: { identity: string; name: string; ttl?: number },
    pour: 'livreur' | 'personnel',
  ) {
    let room: { slug: string; name: string };
    try {
      room = await this.lunion.createRoom(nom, description);
    } catch (e) {
      this.logger.error(`createRoom échec : ${(e as Error).message}`);
      throw this.indisponible(pour);
    }
    try {
      const jeton = await this.lunion.createToken(
        room.slug,
        participant.identity,
        participant.name,
        participant.ttl,
      );
      return {
        room,
        access: {
          room: room.slug,
          token: jeton.token,
          url: jeton.url,
          identity: jeton.identity ?? participant.identity,
        },
      };
    } catch (e) {
      this.logger.error(`createToken échec : ${(e as Error).message}`);
      void this.lunion.deleteRoom(room.slug);
      throw this.indisponible(pour);
    }
  }

  private indisponible(pour: 'livreur' | 'personnel') {
    return new ServiceUnavailableException(
      pour === 'livreur'
        ? {
            message: `L'appel dans l'appli ne marche pas pour l'instant. Appelle le ${NUMERO_LISIBLE}.`,
            code: CODES_APPEL_LIVREUR.INDISPONIBLES,
            telephone: TELEPHONE_SERVICE_CLIENT,
          }
        : { message: "Impossible de créer la room d'appel", code: CODES_APPEL_LIVREUR.INDISPONIBLES },
    );
  }

  /** Journal d'audit : l'intercepteur ne voit que le personnel, les actions du livreur sont écrites ici. */
  private journaliser(
    livreur: LivreurConnecte,
    nom: string,
    e: {
      action: 'CREATE' | 'UPDATE';
      callId: string;
      path: string;
      status: number;
      resume: string;
      details?: Record<string, string | null>;
    },
  ) {
    this.audit.record({
      actor_id: null,
      actor_name: `Livreur ${nom}`,
      actor_role: 'LIVREUR',
      restaurant_id: livreur.restaurant_id ?? null,
      action: e.action,
      module: 'calls',
      entity_id: e.callId,
      method: 'POST',
      path: e.path,
      status_code: e.status,
      summary: e.resume,
      metadata: { delivererId: livreur.id, callId: e.callId, ...(e.details ?? {}) },
    });
  }
}
