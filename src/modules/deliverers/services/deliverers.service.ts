import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  Deliverer,
  DelivererStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { S3Service } from 'src/s3/s3.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { AssignRestaurantDto } from '../dto/assign-restaurant.dto';
import { QueryDeliverersDto } from '../dto/query-deliverers.dto';
import { UpdateDelivererLocationDto } from '../dto/update-location.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { DelivererEvent } from '../events/deliverer.event';
import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import { positionAEnregistrer, releveAssezPrecis } from '../helpers/position-livreur.rules';
import {
  ContexteAppli,
  STATUTS_COURSE_EN_COURS,
  disponibiliteLivreur,
  etatLivreurDepuis,
} from '../helpers/disponibilite.rules';
import { DelivererPushService } from './deliverer-push.service';

/**
 * Lecture de quoi calculer l'état d'un livreur (`disponibilite`) dans une
 * liste : courses en cours et offres en attente, comptées, plus la course de
 * l'offre en attente (l'affectation forcée sur cette course reste permise).
 */
const INCLUDE_DISPONIBILITE = {
  offer_attempts: {
    where: { status: CourseOfferStatus.PENDING },
    select: { course_id: true },
    orderBy: { offered_at: 'desc' as const },
    take: 1,
  },
  _count: {
    select: {
      courses: { where: { statut: { in: STATUTS_COURSE_EN_COURS } } },
      offer_attempts: { where: { status: CourseOfferStatus.PENDING } },
    },
  },
} satisfies Prisma.DelivererInclude;

type SafeDeliverer = Omit<Deliverer, 'password' | 'refresh_token'>;

/**
 * `appli_connectee` d'un livreur dans les listes : l'appli a-t-elle un socket
 * ouvert ? `null` si la présence n'a pas pu être lue (Redis trop lent).
 * « Disponible » et un GPS récent viennent du HTTP : sans socket, il ne
 * recevra pourtant les offres que par notification.
 */
function presence(connectes: Set<string> | null, delivererId: string): boolean | null {
  return connectes ? connectes.has(delivererId) : null;
}

/**
 * État de l'appli d'un livreur dans les listes (demande du 24/10), à côté de
 * `appli_connectee` :
 *  - `appli_active` : socket ouvert ou signe de vie récent ; faux, « Appli
 *    fermée » (plus aucune offre jusqu'à sa réouverture). Vrai sans socket :
 *    appli en arrière-plan, les offres lui arrivent par notification ;
 *  - `appli_vue_a` : dernier signe de vie (position ou requête), ISO.
 */
function etatAppli(disponibilite: { appli_active: boolean; appli_vue_a: Date | null }) {
  return {
    appli_active: disponibilite.appli_active,
    appli_vue_a: disponibilite.appli_vue_a?.toISOString() ?? null,
  };
}

/**
 * Logique métier pour le CRUD livreur (côté admin) et le self-service (côté livreur).
 *
 * Règle métier centrale : `is_operational = (status == ACTIVE && restaurant_id != null)`.
 * Chaque transition de statut ou affectation recalcule ce flag et émet un événement.
 */
@Injectable()
export class DeliverersService {
  private readonly logger = new Logger(DeliverersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
    private readonly delivererEvent: DelivererEvent,
    private readonly scoringSettings: DelivererScoringSettingsHelper,
    // P-push livreur : push "Compte validé !" à l'activation
    private readonly pushService: DelivererPushService,
    // Présence de l'appli (socket ouvert) dans les listes du backoffice
    private readonly gateway: AppGateway,
  ) {}

  // ============================================================
  // ADMIN : LISTE & DÉTAIL
  // ============================================================

  async findAll(query: QueryDeliverersDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.DelivererWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(query.status && { status: query.status }),
      ...(query.restaurant_id && { restaurant_id: query.restaurant_id }),
      ...(query.search && {
        OR: [
          { first_name: { contains: query.search, mode: 'insensitive' } },
          { last_name: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.deliverer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          restaurant: {
            select: {
              id: true,
              name: true,
              image: true,
              address: true,
              phone: true,
              latitude: true,
              longitude: true,
            },
          },
          ...INCLUDE_DISPONIBILITE,
        },
        omit: { password: true, refresh_token: true },
      }),
      this.prisma.deliverer.count({ where }),
    ]);

    // État de chaque livreur par la règle unique (fenêtre « Forcer l'affectation »).
    const maintenant = new Date();
    const connectes = await this.gateway.livreursConnectes(items.map((l) => l.id));
    const appli: ContexteAppli = {
      appliFermeeApresS: (await this.scoringSettings.load()).appliFermeeApresS,
      connectes,
    };
    return {
      items: items.map(({ offer_attempts, _count, ...livreur }) => {
        const disponibilite = disponibiliteLivreur(
          etatLivreurDepuis({ ...livreur, _count }, appli, maintenant),
          maintenant,
          offer_attempts[0]?.course_id ?? null,
        );
        return {
          ...livreur,
          disponibilite,
          appli_connectee: presence(connectes, livreur.id),
          ...etatAppli(disponibilite),
        };
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            latitude: true,
            longitude: true,
          },
        },
      },
      omit: { password: true, refresh_token: true },
    });
    if (!deliverer || deliverer.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Livreur non trouvé');
    }
    return deliverer;
  }

  // ============================================================
  // ADMIN : VALIDATION / REJET / SUSPENSION / AFFECTATION
  // ============================================================

  /**
   * Valide un livreur en attente : passe PENDING → ACTIVE.
   * Recalcule is_operational selon l'affectation à un restaurant.
   */
  async validate(id: string) {
    const deliverer = await this.getNonDeleted(id);

    if (
      deliverer.status !== DelivererStatus.PENDING_VALIDATION &&
      deliverer.status !== DelivererStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Seuls les comptes en attente ou refusés peuvent être validés',
      );
    }
    if (!deliverer.piece_identite || !deliverer.permis_conduire) {
      throw new BadRequestException('Documents obligatoires manquants');
    }

    const activated = await this.transitionStatus(deliverer, DelivererStatus.ACTIVE);

    // P-push livreur : alerte CRITIQUE — le livreur attendait peut-être depuis
    // plusieurs jours, il doit savoir tout de suite qu'il peut commencer à bosser.
    // Récupère le nom du restaurant pour personnaliser le body.
    const restaurant = activated.restaurant_id
      ? await this.prisma.restaurant.findUnique({
          where: { id: activated.restaurant_id },
          select: { name: true },
        })
      : null;
    this.pushService.notifyAccountActivated({
      delivererId: activated.id,
      restaurantName: restaurant?.name,
    });

    return activated;
  }

  async reject(id: string, reason: string) {
    const deliverer = await this.getNonDeleted(id);
    if (deliverer.status === DelivererStatus.REJECTED) {
      throw new BadRequestException('Livreur déjà refusé');
    }
    const rejected = await this.transitionStatus(deliverer, DelivererStatus.REJECTED, reason);
    // Push CRITIQUE — le livreur doit savoir immédiatement que sa candidature est refusée.
    this.pushService.notifyAccountRejected({ delivererId: rejected.id, reason });
    return rejected;
  }

  /**
   * Resoumission par le livreur lui-même après un refus : REJECTED → PENDING_VALIDATION.
   * Le livreur a corrigé ses infos/documents ; sa demande repart dans la file de
   * validation admin. Idempotent : exige le statut REJECTED en entrée (sinon BadRequest),
   * ce qui empêche le spam PENDING→PENDING. Reste non-opérationnel jusqu'à validation admin.
   */
  async resubmit(id: string) {
    const deliverer = await this.getNonDeleted(id);
    if (deliverer.status !== DelivererStatus.REJECTED) {
      throw new BadRequestException('Seule une demande refusée peut être resoumise');
    }
    if (!deliverer.piece_identite || !deliverer.permis_conduire) {
      throw new BadRequestException(
        'Documents obligatoires manquants — complétez votre profil avant de resoumettre',
      );
    }
    // → PENDING_VALIDATION (le motif de refus est effacé par transitionStatus).
    return this.transitionStatus(deliverer, DelivererStatus.PENDING_VALIDATION);
  }

  /**
   * Définit le LIEU D'HABITATION (domicile) du livreur — distinct du GPS temps réel
   * (`last_location`). Utilisé côté admin pour classer les restaurants par proximité.
   */
  async setHomeLocation(
    id: string,
    dto: { lat: number; lng: number; address?: string },
  ) {
    await this.getNonDeleted(id);
    return this.prisma.deliverer.update({
      where: { id },
      data: {
        home_location: { lat: dto.lat, lng: dto.lng },
        home_address: dto.address ?? undefined,
      },
      omit: { password: true, refresh_token: true },
    });
  }

  async suspend(id: string, reason?: string) {
    const deliverer = await this.getNonDeleted(id);
    if (deliverer.status === DelivererStatus.SUSPENDED) {
      throw new BadRequestException('Livreur déjà suspendu');
    }
    const suspended = await this.transitionStatus(deliverer, DelivererStatus.SUSPENDED, reason);
    // Push CRITIQUE — le livreur doit savoir qu'il ne peut plus recevoir de courses.
    this.pushService.notifyAccountSuspended({ delivererId: suspended.id, reason });
    return suspended;
  }

  async reactivate(id: string) {
    const deliverer = await this.getNonDeleted(id);
    if (deliverer.status !== DelivererStatus.SUSPENDED) {
      throw new BadRequestException('Seuls les livreurs suspendus peuvent être réactivés');
    }
    const reactivated = await this.transitionStatus(deliverer, DelivererStatus.ACTIVE);
    // Push CRITIQUE — bonne nouvelle, le livreur peut reprendre du service.
    this.pushService.notifyAccountReactivated({ delivererId: reactivated.id });
    return reactivated;
  }

  /**
   * Force l'activation d'un livreur en attente sans vérifier les documents.
   * Réservé à l'admin — à utiliser quand le livreur n'a pas pu uploader ses docs
   * via l'app mobile mais doit être opérationnel immédiatement.
   */
  async forceActivate(id: string) {
    const deliverer = await this.getNonDeleted(id);

    if (deliverer.status !== DelivererStatus.PENDING_VALIDATION) {
      throw new BadRequestException('Seuls les comptes en attente peuvent être activés');
    }

    // Bypass du check document — l'admin prend la responsabilité
    const activated = await this.transitionStatus(deliverer, DelivererStatus.ACTIVE);

    const restaurant = activated.restaurant_id
      ? await this.prisma.restaurant.findUnique({
          where: { id: activated.restaurant_id },
          select: { name: true },
        })
      : null;
    this.pushService.notifyAccountActivated({
      delivererId: activated.id,
      restaurantName: restaurant?.name,
    });

    return activated;
  }

  async assignRestaurant(id: string, dto: AssignRestaurantDto) {
    const deliverer = await this.getNonDeleted(id);

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: dto.restaurant_id, entity_status: EntityStatus.ACTIVE },
    });
    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé ou inactif');
    }

    const previousStatus = deliverer.status;
    const updated = await this.prisma.deliverer.update({
      where: { id },
      data: {
        restaurant_id: dto.restaurant_id,
        is_operational: deliverer.status === DelivererStatus.ACTIVE,
      },
      include: { restaurant: { select: { id: true, name: true } } },
      omit: { password: true, refresh_token: true },
    });

    await this.delivererEvent.operationalChanged({
      deliverer: updated,
      previousStatus,
      is_operational: updated.is_operational,
    });

    return updated;
  }

  async softDelete(id: string) {
    const deliverer = await this.getNonDeleted(id);
    const updated = await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: {
        entity_status: EntityStatus.DELETED,
        is_operational: false,
        refresh_token: null,
      },
      omit: { password: true, refresh_token: true },
    });
    await this.delivererEvent.operationalChanged({
      deliverer: updated,
      previousStatus: deliverer.status,
      is_operational: false,
      reason: 'Compte supprimé',
    });
    return { id: updated.id, deleted: true };
  }

  // ============================================================
  // LIVREUR : SELF-UPDATE & UPLOADS
  // ============================================================

  async updateSelf(delivererId: string, dto: UpdateProfileDto) {
    if (dto.email) {
      const emailTaken = await this.prisma.deliverer.findFirst({
        where: {
          email: dto.email,
          id: { not: delivererId },
          entity_status: { not: EntityStatus.DELETED },
        },
      });
      if (emailTaken) {
        throw new ConflictException('Cet email est déjà utilisé');
      }
    }

    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: dto,
      omit: { password: true, refresh_token: true },
    });
  }

  /**
   * Enregistre le token Expo Push du livreur (P-chat livreur).
   *
   * Appelé par le mobile au login + à chaque renouvellement de token (rare,
   * géré automatiquement par expo-notifications). Permet à `ExpoPushService`
   * d'envoyer des notifications push (nouveau message support, nouvelle course,
   * auto-pause, etc.) même app fermée.
   *
   * Idempotent : on update sans rien valider — le token est forcément un
   * `ExponentPushToken[...]` validé côté Expo.
   */
  async registerExpoPushToken(delivererId: string, token: string) {
    await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { expo_push_token: token },
    });
    return { success: true, message: 'Token enregistré' };
  }

  async uploadDocument(
    delivererId: string,
    file: Express.Multer.File,
    field: 'image' | 'piece_identite' | 'permis_conduire',
  ) {
    if (!file) {
      throw new BadRequestException('Aucun fichier reçu');
    }

    // Convention S3 du projet : `chicken-nation/{nom-en-kebab}` plat, pas de sous-dossiers profonds.
    // Cohérent avec `users-avatar`, `customer-avatar`, `carte-etudiant`, etc.
    const folderMap = {
      image: 'chicken-nation/deliverers-avatar',
      piece_identite: 'chicken-nation/deliverers-piece-identite',
      permis_conduire: 'chicken-nation/deliverers-permis-conduire',
    };

    const result = await this.s3Service.uploadFile({
      buffer: file.buffer,
      path: folderMap[field],
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    if (!result) {
      throw new BadRequestException('Échec de l\'upload du fichier');
    }

    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { [field]: result.key },
      omit: { password: true, refresh_token: true },
    });
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  private async getNonDeleted(id: string): Promise<Deliverer> {
    const deliverer = await this.prisma.deliverer.findUnique({ where: { id } });
    if (!deliverer || deliverer.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Livreur non trouvé');
    }
    return deliverer;
  }

  /**
   * Transition de statut atomique : recalcule is_operational et émet l'event.
   * is_operational devient true UNIQUEMENT si status == ACTIVE et restaurant affecté.
   */
  private async transitionStatus(
    deliverer: Deliverer,
    newStatus: DelivererStatus,
    reason?: string,
  ): Promise<SafeDeliverer> {
    const previousStatus = deliverer.status;
    const willBeOperational =
      newStatus === DelivererStatus.ACTIVE && !!deliverer.restaurant_id;

    const updated = await this.prisma.deliverer.update({
      where: { id: deliverer.id },
      data: {
        status: newStatus,
        is_operational: willBeOperational,
        // Révoque les sessions si suspendu/refusé
        ...(newStatus !== DelivererStatus.ACTIVE && { refresh_token: null }),
        // Motif de refus : persisté sur REJECTED, effacé sur toute autre transition
        // (validation, resoumission, réactivation…).
        rejection_reason:
          newStatus === DelivererStatus.REJECTED ? (reason ?? null) : null,
      },
      include: { restaurant: { select: { id: true, name: true } } },
      omit: { password: true, refresh_token: true },
    });

    await this.delivererEvent.operationalChanged({
      deliverer: updated,
      previousStatus,
      is_operational: updated.is_operational,
      reason,
    });

    return updated;
  }

  // ============================================================
  // GÉOLOCALISATION & DISPONIBILITÉ (self-service mobile)
  // ============================================================

  /**
   * Met à jour la position GPS + vitesse + cap du livreur. Appelé par le mobile
   * toutes les `deliverer.gps_update_interval_seconds` secondes (default 60s).
   *
   * Validation de la vitesse : si `speedMs * 3.6 > gps_max_speed_kmh`, on refuse
   * la remontée (ping GPS aberrant, saut de position). On ne throw pas — on
   * log un warning et on ignore la vitesse mais on accepte la position, car
   * même une position « suspecte » peut être valide en zone rurale avec mauvaise
   * précision. Le scoring l'ignorera si `last_location_at` est trop ancien.
   */
  async updateLocation(delivererId: string, dto: UpdateDelivererLocationDto) {
    const settings = await this.scoringSettings.load();
    const speedKmh =
      typeof dto.speedMs === 'number' && Number.isFinite(dto.speedMs)
        ? dto.speedMs * 3.6
        : null;

    let validatedSpeed = speedKmh;
    if (speedKmh !== null && speedKmh > settings.gpsMaxSpeedKmh) {
      this.logger.warn(
        `Vitesse aberrante (${speedKmh.toFixed(1)} km/h > ${settings.gpsMaxSpeedKmh}) pour livreur ${delivererId} — ignorée`,
      );
      validatedSpeed = null;
    }

    const now = new Date();
    // Relevé imprécis (plus de 80 m) : la dernière position précise est
    // gardée à côté, seule à décider départ, comptoir et sac attendu.
    const precision = typeof dto.accuracy === 'number' && Number.isFinite(dto.accuracy) ? dto.accuracy : null;
    const precedente = releveAssezPrecis(precision)
      ? null
      : await this.prisma.deliverer.findUnique({
          where: { id: delivererId },
          select: { last_location: true, last_location_at: true },
        });
    const updated = await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: {
        last_location: positionAEnregistrer(
          { lat: dto.lat, lng: dto.lng, precision_m: precision },
          precedente,
        ) as unknown as Prisma.InputJsonValue,
        last_location_at: now,
        last_speed_kmh: validatedSpeed,
        last_heading_deg: dto.heading ?? null,
        // Une position reçue est un signe de vie (filet hors service sans signal).
        dernier_signal_at: now,
      },
      select: {
        id: true,
        restaurant_id: true,
        last_location: true,
        last_location_at: true,
        last_speed_kmh: true,
        last_heading_deg: true,
      },
    });

    // Suivi temps réel : relaie la position via l'event-bus interne. Deux
    // listeners le consomment (fire-and-forget, ne bloque pas la réponse REST) :
    //  1. module course → `delivery:location` au(x) client(s) de la course active.
    //  2. DelivererListenerService → `deliverer:location:live` au staff
    //     (backoffice + restaurant) pour la carte temps réel des livreurs.
    // On transmet `restaurantId` pour cibler la room restaurant sans re-requête.
    this.delivererEvent.locationUpdated({
      delivererId,
      lat: dto.lat,
      lng: dto.lng,
      heading: dto.heading ?? null,
      speedKmh: validatedSpeed,
      ts: now.toISOString(),
      accuracyM: typeof dto.accuracy === 'number' && Number.isFinite(dto.accuracy) ? dto.accuracy : null,
      restaurantId: updated.restaurant_id ?? null,
    });

    return updated;
  }

  // Pause, reprise, entrée et sortie de la file, déconnexion : DisponibiliteLivreurService
  // (la pause enregistrée au serveur est la seule vérité, demande du 22/10).

  // ============================================================
  // DASHBOARD LIVE (P6c) — carte temps réel des livreurs actifs
  // ============================================================

  /**
   * Retourne la liste des livreurs ACTIVE + opérationnels avec leur position
   * GPS récente + statut de disponibilité dérivé + course active éventuelle.
   *
   * Les livreurs sans GPS récent (`last_location_at > gps_expiration_minutes`)
   * sont **exclus par défaut** — on ne veut pas afficher des markers obsolètes
   * sur la carte admin. Passer `includeOffline=true` pour les voir quand même.
   */
  async getLiveLocations(params: { restaurantId?: string; includeOffline?: boolean }) {
    const now = new Date();
    const settings = await this.scoringSettings.load();
    const gpsExpirationMs = settings.gpsExpirationMinutes * 60_000;

    const deliverers = await this.prisma.deliverer.findMany({
      where: {
        status: DelivererStatus.ACTIVE,
        is_operational: true,
        entity_status: { not: EntityStatus.DELETED },
        ...(params.restaurantId && { restaurant_id: params.restaurantId }),
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        image: true,
        type_vehicule: true,
        restaurant_id: true,
        restaurant: { select: { id: true, name: true } },
        last_location: true,
        last_location_at: true,
        last_speed_kmh: true,
        last_heading_deg: true,
        last_available_at: true,
        pause_until: true,
        auto_pause_until: true,
        dernier_signal_at: true,
        status: true,
        is_operational: true,
        entity_status: true,
        ...INCLUDE_DISPONIBILITE,
        courses: {
          where: {
            statut: {
              in: [
                CourseStatut.ACCEPTED,
                CourseStatut.AT_RESTAURANT,
                CourseStatut.IN_DELIVERY,
              ],
            },
          },
          select: {
            id: true,
            reference: true,
            statut: true,
            assigned_at: true,
            deliveries: {
              orderBy: { sequence_order: 'asc' },
              select: {
                id: true,
                statut: true,
                sequence_order: true,
                order: { select: { address: true, reference: true } },
              },
            },
          },
          take: 1,
        },
      },
    });

    // Rang FIFO pour les livreurs disponibles
    const inQueue = deliverers
      .filter((d) => d.last_available_at !== null)
      .sort(
        (a, b) =>
          (a.last_available_at?.getTime() ?? 0) -
          (b.last_available_at?.getTime() ?? 0),
      );
    const rankMap = new Map<string, number>();
    inQueue.forEach((d, i) => rankMap.set(d.id, i + 1));

    const connectes = await this.gateway.livreursConnectes(deliverers.map((d) => d.id));
    const appli: ContexteAppli = { appliFermeeApresS: settings.appliFermeeApresS, connectes };
    const result = deliverers
      .map((d) => {
        const locationAt = d.last_location_at;
        const locationFresh =
          locationAt !== null && now.getTime() - locationAt.getTime() <= gpsExpirationMs;

        // Statut de disponibilité
        const inPause = d.pause_until !== null && d.pause_until > now;
        const inAutoPause = d.auto_pause_until !== null && d.auto_pause_until > now;
        const activeCourse = d.courses[0] ?? null;
        let availability: 'available' | 'paused' | 'auto_paused' | 'in_course' | 'offline';
        if (activeCourse) availability = 'in_course';
        else if (inAutoPause) availability = 'auto_paused';
        else if (inPause) availability = 'paused';
        else if (d.last_available_at) availability = 'available';
        else availability = 'offline';

        // État par la règle unique : « En pause », « Hors service » et « Appli fermée » visibles.
        const disponibilite = disponibiliteLivreur(
          etatLivreurDepuis(d, appli, now),
          now,
          d.offer_attempts[0]?.course_id ?? null,
        );

        return {
          id: d.id,
          first_name: d.first_name,
          last_name: d.last_name,
          image: d.image,
          type_vehicule: d.type_vehicule,
          restaurant: d.restaurant,
          location: d.last_location,
          location_at: locationAt?.toISOString() ?? null,
          location_fresh: locationFresh,
          speed_kmh: d.last_speed_kmh,
          heading_deg: d.last_heading_deg,
          availability,
          queue_rank: rankMap.get(d.id) ?? null,
          pause_until: d.pause_until?.toISOString() ?? null,
          auto_pause_until: d.auto_pause_until?.toISOString() ?? null,
          disponibilite,
          appli_connectee: presence(connectes, d.id),
          ...etatAppli(disponibilite),
          active_course: activeCourse
            ? {
                id: activeCourse.id,
                reference: activeCourse.reference,
                statut: activeCourse.statut,
                assigned_at: activeCourse.assigned_at?.toISOString() ?? null,
                deliveries: activeCourse.deliveries.map((dv) => ({
                  id: dv.id,
                  statut: dv.statut,
                  sequence_order: dv.sequence_order,
                  order_reference: dv.order?.reference ?? null,
                  address: dv.order?.address ?? null,
                })),
              }
            : null,
        };
      })
      .filter((d) => params.includeOffline || d.location_fresh);

    return result;
  }
}
