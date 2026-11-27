import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CallStatus,
  CourseStatut,
  Customer,
  DeliveryStatut,
  EntityStatus,
  User,
  UserType,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import {
  APPELANT_CLIENT,
  APPELS_CLIENT_FENETRE_MS,
  APPELS_CLIENT_MAX,
  APPEL_FANTOME_MS,
  CALLS_CLIENTS_ACTIF_KEY,
  CALL_EVENTS,
  CANAL_APPELS_CLIENT,
  CATEGORIE_APPEL_CLIENT,
  CIBLE_CLIENT,
  CIBLE_LIVREUR,
  CODES_APPEL_CLIENT,
  CorrespondantClient,
  LIBELLE_CLIENT,
  LIBELLE_LIVREUR,
  LIBELLE_SERVICE_CLIENT,
  MARGE_SONNERIE_LIVREUR_MS,
  RaisonFinAppel,
  SON_APPEL_CLIENT,
  SONNERIE_LIVREUR_MS,
  TELEPHONE_SERVICE_CLIENT,
  TTL_JETON_CLIENT_S,
} from '../constants/calls.constants';
import { StartCallDto } from '../dto/start-call.dto';
import { StartCustomerCallDto } from '../dto/start-customer-call.dto';
import {
  appelantClient,
  appliClientARafraichir,
  appliClientPrete,
  correspondantDuClient,
  nomClient,
  nomClientPourLivreur,
  peutAppelerClient,
  phasePourClient,
  SELECT_CLIENT_APPEL,
} from '../helpers/appels-client.rules';
import { lireAppelsLivreursActifs, nomLivreur, SELECT_LIVREUR_APPEL } from '../helpers/appels-livreur.rules';
import { AppelsLivreurService } from './appels-livreur.service';
import { CallsConfigService } from './calls-config.service';
import { CallsService } from './calls.service';
import { LunionMeetService } from './lunion-meet.service';

/** Le client connecté, tel que JwtCustomerAuthGuard le pose sur la requête. */
export type ClientConnecte = Pick<Customer, 'id' | 'first_name' | 'last_name' | 'phone'> & {
  appels_appli_at?: Date | null;
};

const STATUTS_FINAUX: CallStatus[] = [
  CallStatus.ENDED,
  CallStatus.MISSED,
  CallStatus.CANCELLED,
  CallStatus.FAILED,
];

/** Course en cours : le livreur a accepté, il est au restaurant ou en livraison. */
const COURSE_EN_COURS: CourseStatut[] = [
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];

/** Livraison pas encore finie : le client attend encore sa commande. */
const LIVRAISON_EN_COURS: DeliveryStatut[] = [
  DeliveryStatut.PENDING,
  DeliveryStatut.IN_ROUTE,
  DeliveryStatut.ARRIVED,
];

/** Sans commande donnée, le service client voit la commande récente du client (12 h). */
const COMMANDE_RECENTE_MS = 12 * 60 * 60 * 1000;

const NUMERO_LISIBLE = '27 21 71 21 30';

type Acces = { room: string; token: string; url: string; identity: string };

/**
 * Appels dans l'appli Chicken Nation, côté client (demande du 26/11) :
 * « permettre depuis l'appli d'appeler le livreur directement, le service
 * client aussi, le service client à son tour doit pouvoir appeler un client
 * dans l'appli ».
 *
 *  - Le client appelle le service client (POST /calls/customer) : sonnerie de
 *    groupe des receveurs d'un appel vers le centre d'appels, premier agent
 *    qui décroche gagne (claim atomique de CallsService.answer). L'agent voit
 *    le nom, le numéro et la commande du client.
 *  - Le client appelle le livreur de sa commande (POST /calls/customer,
 *    `cible: 'LIVREUR'`) : seulement une commande à lui, en cours de livraison
 *    par un livreur de chez nous. L'appli du livreur sonne ; il voit le prénom
 *    du client et la commande, jamais son numéro. Aucun numéro n'est échangé.
 *  - Le service client appelle un client (POST /calls, `targetKind:
 *    'CUSTOMER'`) : l'appli du client sonne (`call:incoming` dans
 *    `customer_{id}` + notification). Refusé (`CLIENT_SANS_APPLI`) quand
 *    l'appli du client n'a jamais dit savoir prendre un appel : l'agent
 *    appelle au téléphone.
 *
 * Un client n'agit que sur SES appels : chaque écriture est conditionnée sur
 * son identifiant (appelant ou appelé). Il ne reçoit qu'un jeton de
 * participant, jamais la clé du service. Ses actions vont au journal d'audit.
 *
 * Réglage `calls.clients_actif` à 0 : appeler et décrocher sont refusés
 * (`APPELS_CLIENTS_DESACTIVES`), l'appli passe au téléphone. Raccrocher et
 * refuser restent possibles : on ne bloque jamais la fin d'un appel.
 *
 * Les minuteries de sonnerie (45 s) et le balayage après redémarrage sont
 * ceux d'AppelsLivreurService : un seul endroit clôt un appel d'appli sans
 * réponse.
 */
@Injectable()
export class AppelsClientService {
  private readonly logger = new Logger(AppelsClientService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lunion: LunionMeetService,
    private readonly config: CallsConfigService,
    private readonly calls: CallsService,
    private readonly appelsLivreur: AppelsLivreurService,
    private readonly gateway: AppGateway,
    private readonly settings: SettingsService,
    private readonly pushLivreur: DelivererPushService,
    private readonly expoPush: ExpoPushService,
    private readonly audit: AuditService,
  ) {}

  // ============================================================
  // RÉGLAGE
  // ============================================================

  /** Réglage `calls.clients_actif` (actif par défaut, et si la base ne répond pas). */
  async actifs(): Promise<boolean> {
    try {
      return lireAppelsLivreursActifs(await this.settings.get(CALLS_CLIENTS_ACTIF_KEY));
    } catch (e) {
      this.logger.warn(`Réglage ${CALLS_CLIENTS_ACTIF_KEY} illisible, appels gardés actifs : ${(e as Error).message}`);
      return true;
    }
  }

  private async exigerActifs(pour: 'client' | 'personnel') {
    if (await this.actifs()) return;
    throw new ForbiddenException(
      pour === 'client'
        ? {
            message: `L'appel dans l'appli est coupé pour l'instant. Appelez le ${NUMERO_LISIBLE}.`,
            code: CODES_APPEL_CLIENT.DESACTIVES,
            telephone: TELEPHONE_SERVICE_CLIENT,
          }
        : {
            message: 'Les appels avec les clients dans l’appli sont coupés.',
            code: CODES_APPEL_CLIENT.DESACTIVES,
          },
    );
  }

  // ============================================================
  // LE CLIENT APPELLE (service client ou livreur de sa commande)
  // ============================================================

  async appeler(client: ClientConnecte, dto: StartCustomerCallDto) {
    return dto.cible === 'LIVREUR'
      ? this.appelerSonLivreur(client, dto)
      : this.appelerServiceClient(client, dto);
  }

  private async appelerServiceClient(client: ClientConnecte, dto: StartCustomerCallDto) {
    await this.exigerActifs('client');
    await this.appelsLivreur.balayer();
    await this.refuserSiDejaEnAppel(client.id);
    await this.refuserSiTropDAppels(client.id);

    const commande = await this.commandeDuClient(client.id, dto.order_id, true);

    // Receveurs d'un appel vers le centre d'appels : ceux de la config de
    // routage (appelant RESTAURANT → rôle CALL_CENTER par défaut).
    const regle = (await this.config.getConfig())[UserType.RESTAURANT];
    const receveurs = await this.calls.resolveReceivers(
      regle.receiverType,
      regle.receiverRoles,
      null,
      client.id,
    );
    if (receveurs.length === 0) {
      throw new ServiceUnavailableException({
        message: `Personne au service client pour l'instant. Appelez le ${NUMERO_LISIBLE}.`,
        code: CODES_APPEL_CLIENT.AUCUN_AGENT,
        telephone: TELEPHONE_SERVICE_CLIENT,
      });
    }

    const nom = nomClient(client);
    const { room, access } = await this.ouvrirSalle(
      `cn-client-${client.id.slice(0, 8)}`,
      `Appel ${nom} → ${LIBELLE_SERVICE_CLIENT}`,
      { identity: `client-${client.id}`, name: nom, ttl: TTL_JETON_CLIENT_S },
      'client',
    );

    const call = await this.prisma.call.create({
      data: {
        room_slug: room.slug,
        room_name: room.name,
        status: CallStatus.RINGING,
        caller_id: null,
        caller_type: null,
        caller_customer_id: client.id,
        target_kind: 'CALL_CENTER',
        ringing_user_ids: receveurs.map((r) => r.id),
        rung_user_ids: receveurs.map((r) => r.id),
        order_id: commande?.id ?? null,
      },
    });

    const appelant = appelantClient(client, commande);
    let online = 0;
    for (const r of receveurs) {
      if (this.gateway.isUserOnline(r.id)) online++;
      this.gateway.emitToUser(r.id, 'user', CALL_EVENTS.INCOMING, {
        callId: call.id,
        room: room.slug,
        callerId: client.id,
        callerName: nom,
        callerType: APPELANT_CLIENT,
        targetKind: 'CALL_CENTER',
        targetLabel: 'Call Center',
        startedAt: call.started_at,
        client: appelant,
      });
    }
    this.appelsLivreur.armerSonnerie(call.id);
    this.journaliser(client, {
      action: 'CREATE',
      callId: call.id,
      path: '/calls/customer',
      status: 201,
      resume: `Client : appel au call center (${receveurs.length} poste(s) sonnent)`,
      details: { orderId: commande?.id ?? null },
    });

    return {
      call: { id: call.id, status: call.status, started_at: call.started_at, order_id: call.order_id },
      access,
      ringing: receveurs.length,
      online,
      correspondant: 'SERVICE_CLIENT' satisfies CorrespondantClient,
      targetLabel: LIBELLE_SERVICE_CLIENT,
    };
  }

  /**
   * Le client appelle le livreur de SA commande : une livraison pas encore
   * finie, dans une course qu'un livreur de chez nous a prise. Sinon
   * `LIVREUR_INJOIGNABLE` (pas encore parti, déjà livré, livreur partenaire) :
   * l'appli garde ce qu'elle faisait avant.
   */
  private async appelerSonLivreur(client: ClientConnecte, dto: StartCustomerCallDto) {
    await this.exigerActifs('client');
    if (!dto.order_id) throw new BadRequestException('order_id requis pour appeler le livreur');
    // Réglage des appels livreur coupé : son appli refuserait de décrocher.
    if (!(await this.appelsLivreur.actifs())) throw this.livreurInjoignable();

    const livraison = await this.prisma.delivery.findFirst({
      where: {
        order_id: dto.order_id,
        order: { customer_id: client.id },
        statut: { in: LIVRAISON_EN_COURS },
        course: { deliverer_id: { not: null }, statut: { in: COURSE_EN_COURS } },
      },
      select: {
        order: { select: { id: true, reference: true } },
        course: { select: { id: true, reference: true, deliverer_id: true } },
      },
    });
    const delivererId = livraison?.course?.deliverer_id ?? null;
    const livreur = delivererId
      ? await this.prisma.deliverer.findFirst({
          where: { id: delivererId, entity_status: EntityStatus.ACTIVE },
          select: SELECT_LIVREUR_APPEL,
        })
      : null;
    if (!livraison || !livreur) throw this.livreurInjoignable();

    await this.appelsLivreur.balayer();
    await this.refuserSiDejaEnAppel(client.id);
    await this.refuserSiTropDAppels(client.id);
    if (await this.appelsLivreur.livreurEnAppel(livreur.id)) {
      throw new ConflictException({
        message: 'Votre livreur est déjà en ligne. Réessayez dans un instant.',
        code: CODES_APPEL_CLIENT.LIVREUR_OCCUPE,
      });
    }

    const nom = nomClient(client);
    const { room, access } = await this.ouvrirSalle(
      `cn-client-${client.id.slice(0, 8)}`,
      `Appel ${nom} → livreur ${nomLivreur(livreur)}`,
      { identity: `client-${client.id}`, name: nom, ttl: TTL_JETON_CLIENT_S },
      'client',
    );

    const call = await this.prisma.call.create({
      data: {
        room_slug: room.slug,
        room_name: room.name,
        status: CallStatus.RINGING,
        caller_id: null,
        caller_type: null,
        caller_customer_id: client.id,
        target_kind: CIBLE_LIVREUR,
        target_deliverer_id: livreur.id,
        ringing_user_ids: [],
        rung_user_ids: [],
        course_id: livraison.course.id,
        order_id: livraison.order.id,
      },
    });

    // Le livreur voit le prénom du client et la commande, jamais son numéro.
    this.gateway.emitToDeliverer(livreur.id, CALL_EVENTS.INCOMING, {
      callId: call.id,
      room: room.slug,
      callerName: nomClientPourLivreur(client),
      callerLabel: LIBELLE_CLIENT,
      appelant: 'CLIENT',
      order_reference: livraison.order.reference,
      startedAt: call.started_at,
      expiresAt: new Date(call.started_at.getTime() + SONNERIE_LIVREUR_MS),
    });
    // Appli du livreur fermée ou en arrière-plan : la notification le prévient.
    this.pushLivreur.notifyAppelEntrant({ delivererId: livreur.id, callId: call.id, deClient: true });
    this.appelsLivreur.armerSonnerie(call.id);
    this.journaliser(client, {
      action: 'CREATE',
      callId: call.id,
      path: '/calls/customer',
      status: 201,
      resume: 'Client : appel au livreur de sa commande',
      details: { orderId: livraison.order.id, delivererId: livreur.id },
    });

    const connecte = await this.gateway.livreurConnecte(livreur.id);
    return {
      call: { id: call.id, status: call.status, started_at: call.started_at, order_id: call.order_id },
      access,
      ringing: 1,
      online: connecte === false ? 0 : 1,
      correspondant: 'LIVREUR' satisfies CorrespondantClient,
      targetLabel: LIBELLE_LIVREUR,
    };
  }

  // ============================================================
  // LE SERVICE CLIENT APPELLE UN CLIENT
  // ============================================================

  async appelerClient(caller: User, dto: StartCallDto) {
    if (!peutAppelerClient(caller.role)) {
      throw new ForbiddenException("Votre profil n'est pas autorisé à appeler un client dans l'appli");
    }
    await this.exigerActifs('personnel');
    if (!dto.customer_id) throw new BadRequestException('customer_id requis');

    const client = await this.prisma.customer.findFirst({
      where: { id: dto.customer_id, entity_status: EntityStatus.ACTIVE },
      select: {
        ...SELECT_CLIENT_APPEL,
        appels_appli_at: true,
        notification_settings: { select: { expo_push_token: true, push: true, active: true } },
      },
    });
    if (!client) throw new NotFoundException('Client introuvable');

    // Appli installée avant les appels, désinstallée, ou jamais ouverte depuis
    // longtemps : elle ne sonnerait pas. L'agent appelle au téléphone.
    if (!appliClientPrete(client.appels_appli_at, Date.now())) {
      throw new ConflictException({
        message: "L'appli de ce client ne peut pas recevoir d'appel. Appelez-le au téléphone.",
        code: CODES_APPEL_CLIENT.SANS_APPLI,
        telephone: client.phone,
      });
    }

    await this.appelsLivreur.balayer();
    if (await this.appelActifDuClient(client.id)) {
      throw new ConflictException({
        message: 'Ce client est déjà en appel.',
        code: CODES_APPEL_CLIENT.EN_COURS,
      });
    }

    const commande = await this.commandeDuClient(client.id, dto.order_id, false);
    const nom = nomClient(client);
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
        target_kind: CIBLE_CLIENT,
        target_customer_id: client.id,
        ringing_user_ids: [],
        rung_user_ids: [],
        order_id: commande?.id ?? null,
      },
    });

    // Le client voit « Service client », jamais le nom de l'agent.
    this.gateway.emitToUser(client.id, 'customer', CALL_EVENTS.INCOMING, {
      callId: call.id,
      room: room.slug,
      callerLabel: LIBELLE_SERVICE_CLIENT,
      correspondant: 'SERVICE_CLIENT' satisfies CorrespondantClient,
      order_reference: commande?.reference ?? null,
      startedAt: call.started_at,
      expiresAt: new Date(call.started_at.getTime() + SONNERIE_LIVREUR_MS),
    });
    // Appli fermée ou en arrière-plan : la notification le prévient.
    const reglages = client.notification_settings;
    if (reglages?.expo_push_token && reglages.push && reglages.active) {
      void this.expoPush
        .sendPushNotifications({
          tokens: [reglages.expo_push_token],
          title: 'Chicken Nation vous appelle',
          body: 'Touchez pour répondre.',
          // Téléphone verrouillé (27/11) : canal d'appels, sonnerie longue.
          sound: SON_APPEL_CLIENT,
          channelId: CANAL_APPELS_CLIENT,
          categoryId: CATEGORIE_APPEL_CLIENT,
          priority: 'high',
          // Un appel ne sonne pas après coup : passé la sonnerie, il est manqué.
          ttl: Math.round(SONNERIE_LIVREUR_MS / 1000),
          data: { type: 'appel_entrant', callId: call.id },
        })
        .catch((e) => this.logger.warn(`Notification d'appel non envoyée : ${(e as Error).message}`));
    }
    this.appelsLivreur.armerSonnerie(call.id);

    return {
      call,
      access,
      ringing: 1,
      online: this.gateway.isUserOnline(client.id) ? 1 : 0,
      targetLabel: nom,
      client: appelantClient(client, commande),
    };
  }

  // ============================================================
  // DÉCROCHER, REFUSER, RACCROCHER (côté client)
  // ============================================================

  /**
   * Le client décroche un appel du service client. Le jeton est demandé avant
   * le claim (Lunion muet : l'appel continue de sonner, rien n'est perdu),
   * puis RINGING → ONGOING conditionné sur l'appel ET sur le client appelé.
   */
  async decrocher(client: ClientConnecte, callId: string) {
    await this.exigerActifs('client');
    const call = await this.appelDuClient(callId, client.id, 'appele');
    if (call.status !== CallStatus.RINGING) return { taken: true, status: call.status };

    const nom = nomClient(client);
    let jeton: Awaited<ReturnType<LunionMeetService['createToken']>>;
    try {
      jeton = await this.lunion.createToken(call.room_slug, `client-${client.id}`, nom, TTL_JETON_CLIENT_S);
    } catch (e) {
      this.logger.error(`Jeton Lunion refusé pour le client ${client.id.slice(0, 8)} : ${(e as Error).message}`);
      throw this.indisponible('client');
    }

    const pris = await this.prisma.call.updateMany({
      where: { id: callId, status: CallStatus.RINGING, target_customer_id: client.id },
      data: { status: CallStatus.ONGOING, answered_at: new Date() },
    });
    if (pris.count === 0) {
      // Annulé par l'agent ou manqué entre-temps : le jeton n'est jamais rendu.
      const frais = await this.prisma.call.findUnique({ where: { id: callId }, select: { status: true } });
      return { taken: true, status: frais?.status ?? call.status };
    }
    this.appelsLivreur.desarmerSonnerie(callId);

    this.calls.prevenirAppelant(call, CALL_EVENTS.ACCEPTED, {
      callId: call.id,
      answeredById: client.id,
      answeredByName: nom,
    });
    // Ses autres appareils arrêtent de sonner (celui qui a décroché l'ignore).
    this.gateway.emitToUser(client.id, 'customer', CALL_EVENTS.TAKEN, { callId: call.id });
    this.journaliser(client, {
      action: 'UPDATE',
      callId,
      path: `/calls/customer/${callId}/answer`,
      status: 201,
      resume: 'Client : a décroché un appel du call center',
    });

    return {
      taken: false,
      call: { id: call.id, room_slug: call.room_slug },
      access: {
        room: call.room_slug,
        token: jeton.token,
        url: jeton.url,
        identity: jeton.identity ?? `client-${client.id}`,
      } satisfies Acces,
    };
  }

  /** Le client refuse un appel du service client : appel manqué, l'agent reçoit `call:ended` (`rejected`). */
  async refuser(client: ClientConnecte, callId: string) {
    const call = await this.appelDuClient(callId, client.id, 'appele');
    if (call.status !== CallStatus.RINGING) return { status: call.status };

    const refuse = await this.prisma.call.updateMany({
      where: { id: callId, status: CallStatus.RINGING, target_customer_id: client.id },
      data: { status: CallStatus.MISSED, ended_at: new Date() },
    });
    if (refuse.count === 0) {
      const frais = await this.prisma.call.findUnique({ where: { id: callId }, select: { status: true } });
      return { status: frais?.status ?? call.status };
    }
    this.appelsLivreur.desarmerSonnerie(callId);

    const fin = { callId: call.id, reason: 'rejected' satisfies RaisonFinAppel };
    this.calls.prevenirAppelant(call, CALL_EVENTS.ENDED, fin);
    this.gateway.emitToUser(client.id, 'customer', CALL_EVENTS.ENDED, fin);
    void this.lunion.deleteRoom(call.room_slug);
    this.journaliser(client, {
      action: 'UPDATE',
      callId,
      path: `/calls/customer/${callId}/reject`,
      status: 201,
      resume: 'Client : a refusé un appel du call center',
    });
    return { status: CallStatus.MISSED };
  }

  /**
   * Le client raccroche : annule son appel qui sonne encore (CANCELLED, les
   * agents ou le livreur arrêtent de sonner), refuse un appel du service
   * client qui sonne, ou termine l'appel en cours (ENDED, l'autre côté reçoit
   * `call:ended`).
   */
  async raccrocher(client: ClientConnecte, callId: string) {
    const call = await this.appelDuClient(callId, client.id, 'partie');
    if (STATUTS_FINAUX.includes(call.status)) return { status: call.status };

    const journal = (resume: string) =>
      this.journaliser(client, {
        action: 'UPDATE',
        callId,
        path: `/calls/customer/${callId}/hangup`,
        status: 201,
        resume,
      });

    if (call.status === CallStatus.RINGING) {
      if (call.caller_customer_id !== client.id) return this.refuser(client, callId);

      const annule = await this.prisma.call.updateMany({
        where: { id: callId, status: CallStatus.RINGING, caller_customer_id: client.id },
        data: { status: CallStatus.CANCELLED, ended_at: new Date() },
      });
      if (annule.count === 0) {
        // Un agent ou le livreur a décroché au même instant : fin normale.
        const frais = await this.prisma.call.findUnique({ where: { id: callId } });
        if (frais && frais.status === CallStatus.ONGOING) {
          journal('Client : a raccroché');
          return this.calls.terminerAppelEnCours(frais, { type: 'customer', id: client.id });
        }
        return { status: frais?.status ?? CallStatus.CANCELLED };
      }
      this.appelsLivreur.desarmerSonnerie(callId);
      for (const rid of call.ringing_user_ids) {
        this.gateway.emitToUser(rid, 'user', CALL_EVENTS.CANCELLED, { callId: call.id });
      }
      if (call.target_deliverer_id) {
        this.gateway.emitToDeliverer(call.target_deliverer_id, CALL_EVENTS.ENDED, {
          callId: call.id,
          reason: 'cancelled' satisfies RaisonFinAppel,
        });
      }
      void this.lunion.deleteRoom(call.room_slug);
      journal('Client : a annulé son appel avant la réponse');
      return { status: CallStatus.CANCELLED };
    }

    journal('Client : a raccroché');
    return this.calls.terminerAppelEnCours(call, { type: 'customer', id: client.id });
  }

  // ============================================================
  // MON APPEL (reprise au lancement de l'appli)
  // ============================================================

  /**
   * L'appel du client qui sonne ou qui est en cours, avec un jeton frais quand
   * il peut (re)joindre la salle. Un appel du service client qui sonne n'a
   * pas de jeton : il faut décrocher (POST /calls/customer/:id/answer).
   *
   * `natif` : l'appli dit que son binaire sait parler dans l'appli. C'est ici
   * que le serveur l'apprend (`Customer.appels_appli_at`, réécrit une fois
   * par jour au plus) : sans cela, le service client n'appelle pas ce client
   * dans l'appli.
   */
  async monAppel(client: ClientConnecte, natif: boolean) {
    if (natif) this.retenirAppliPrete(client);

    const base = { telephone: TELEPHONE_SERVICE_CLIENT };
    if (!(await this.actifs())) return { actif: false, ...base, call: null, access: null };
    await this.appelsLivreur.balayer();

    const call = await this.appelActifDuClient(client.id);
    if (!call) return { actif: true, ...base, call: null, access: null };

    const { direction, phase } = phasePourClient(call, client.id);
    let access: Acces | null = null;
    if (phase !== 'ringing') {
      try {
        const jeton = await this.lunion.createToken(
          call.room_slug,
          `client-${client.id}`,
          nomClient(client),
          TTL_JETON_CLIENT_S,
        );
        access = {
          room: call.room_slug,
          token: jeton.token,
          url: jeton.url,
          identity: jeton.identity ?? `client-${client.id}`,
        };
      } catch (e) {
        this.logger.warn(`Jeton de reprise refusé pour le client ${client.id.slice(0, 8)} : ${(e as Error).message}`);
      }
    }

    const correspondant = correspondantDuClient(call);
    return {
      actif: true,
      ...base,
      call: {
        callId: call.id,
        status: call.status,
        direction,
        phase,
        correspondant,
        peerLabel: correspondant === 'LIVREUR' ? LIBELLE_LIVREUR : LIBELLE_SERVICE_CLIENT,
        startedAt: call.started_at,
        answeredAt: call.answered_at,
        expiresAt:
          call.status === CallStatus.RINGING
            ? new Date(call.started_at.getTime() + SONNERIE_LIVREUR_MS)
            : null,
        order_id: call.order_id,
        order_reference: call.order?.reference ?? null,
      },
      access,
    };
  }

  /** L'appli de ce client sait prendre un appel : retenu, une fois par jour au plus. Jamais bloquant. */
  private retenirAppliPrete(client: ClientConnecte) {
    if (!appliClientARafraichir(client.appels_appli_at ?? null, Date.now())) return;
    void this.prisma.customer
      .updateMany({ where: { id: client.id }, data: { appels_appli_at: new Date() } })
      .catch((e) => this.logger.warn(`appels_appli_at non écrit : ${(e as Error).message}`));
  }

  // ============================================================
  // OUTILS
  // ============================================================

  /** L'appel du client (appelant ou appelé) qui sonne encore ou qui est en cours. */
  private async appelActifDuClient(customerId: string) {
    const maintenant = Date.now();
    return this.prisma.call.findFirst({
      where: {
        AND: [
          { OR: [{ caller_customer_id: customerId }, { target_customer_id: customerId }] },
          {
            OR: [
              {
                status: CallStatus.RINGING,
                started_at: { gte: new Date(maintenant - SONNERIE_LIVREUR_MS - MARGE_SONNERIE_LIVREUR_MS) },
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
      include: { order: { select: { reference: true } } },
    });
  }

  private async refuserSiDejaEnAppel(customerId: string) {
    const enCours = await this.appelActifDuClient(customerId);
    if (!enCours) return;
    throw new ConflictException({
      message: 'Vous avez déjà un appel en cours.',
      code: CODES_APPEL_CLIENT.EN_COURS,
      callId: enCours.id,
    });
  }

  /** Appels à répétition (6 en 10 min) : refus, l'appli passe au téléphone. */
  private async refuserSiTropDAppels(customerId: string) {
    const recents = await this.prisma.call.count({
      where: {
        caller_customer_id: customerId,
        started_at: { gte: new Date(Date.now() - APPELS_CLIENT_FENETRE_MS) },
      },
    });
    if (recents < APPELS_CLIENT_MAX) return;
    throw new HttpException(
      {
        message: `Trop d'appels en peu de temps. Appelez le ${NUMERO_LISIBLE}.`,
        code: CODES_APPEL_CLIENT.TROP_D_APPELS,
        telephone: TELEPHONE_SERVICE_CLIENT,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Appel du client, ou refus. `appele` : il doit être le client appelé
   * (décrocher, refuser) ; `partie` : appelant ou appelé (raccrocher). Un
   * autre client reçoit 403, quel que soit l'appel.
   */
  private async appelDuClient(callId: string, customerId: string, role: 'appele' | 'partie') {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Appel introuvable');
    const appele = call.target_customer_id === customerId;
    const appelant = call.caller_customer_id === customerId;
    if (role === 'appele' ? !appele : !(appele || appelant)) {
      throw new ForbiddenException('Cet appel ne vous concerne pas');
    }
    return call;
  }

  /**
   * Commande dont il est question : celle qui est donnée si elle est bien au
   * client (sinon ignorée) ; à défaut, quand le client appelle sans préciser,
   * sa commande des 12 dernières heures.
   */
  private async commandeDuClient(customerId: string, orderId: string | undefined, recenteSinon: boolean) {
    if (orderId) {
      const donnee = await this.prisma.order.findFirst({
        where: { id: orderId, customer_id: customerId },
        select: { id: true, reference: true },
      });
      if (donnee) return donnee;
    }
    if (!recenteSinon) return null;
    return this.prisma.order.findFirst({
      where: { customer_id: customerId, created_at: { gte: new Date(Date.now() - COMMANDE_RECENTE_MS) } },
      orderBy: { created_at: 'desc' },
      select: { id: true, reference: true },
    });
  }

  /** Salle Lunion et jeton de l'appelant. Lunion muet : 503 `APPELS_INDISPONIBLES`, salle supprimée. */
  private async ouvrirSalle(
    nom: string,
    description: string,
    participant: { identity: string; name: string; ttl?: number },
    pour: 'client' | 'personnel',
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
        } satisfies Acces,
      };
    } catch (e) {
      this.logger.error(`createToken échec : ${(e as Error).message}`);
      void this.lunion.deleteRoom(room.slug);
      throw this.indisponible(pour);
    }
  }

  private indisponible(pour: 'client' | 'personnel') {
    return new ServiceUnavailableException(
      pour === 'client'
        ? {
            message: `L'appel dans l'appli ne marche pas pour l'instant. Appelez le ${NUMERO_LISIBLE}.`,
            code: CODES_APPEL_CLIENT.INDISPONIBLES,
            telephone: TELEPHONE_SERVICE_CLIENT,
          }
        : { message: "Impossible de créer la room d'appel", code: CODES_APPEL_CLIENT.INDISPONIBLES },
    );
  }

  private livreurInjoignable() {
    return new ConflictException({
      message: "Votre livreur n'est pas joignable dans l'appli pour l'instant.",
      code: CODES_APPEL_CLIENT.LIVREUR_INJOIGNABLE,
    });
  }

  /** Journal d'audit : l'intercepteur ne voit que le personnel, les actions du client sont écrites ici. */
  private journaliser(
    client: ClientConnecte,
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
      actor_name: `Client ${nomClient(client)}`,
      actor_role: 'CLIENT',
      restaurant_id: null,
      action: e.action,
      module: 'calls',
      entity_id: e.callId,
      method: 'POST',
      path: e.path,
      status_code: e.status,
      summary: e.resume,
      metadata: { customerId: client.id, callId: e.callId, ...(e.details ?? {}) },
    });
  }
}
