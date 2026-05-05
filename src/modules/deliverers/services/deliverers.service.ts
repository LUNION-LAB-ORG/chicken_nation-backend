import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatut,
  Deliverer,
  DelivererStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { S3Service } from 'src/s3/s3.service';

import { AssignRestaurantDto } from '../dto/assign-restaurant.dto';
import { PauseDelivererDto } from '../dto/pause-deliverer.dto';
import { QueryDeliverersDto } from '../dto/query-deliverers.dto';
import { UpdateDelivererLocationDto } from '../dto/update-location.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { DelivererEvent } from '../events/deliverer.event';
import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import { DelivererPushService } from './deliverer-push.service';

type SafeDeliverer = Omit<Deliverer, 'password' | 'refresh_token'>;

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
        },
        omit: { password: true, refresh_token: true },
      }),
      this.prisma.deliverer.count({ where }),
    ]);

    return {
      items,
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

    if (deliverer.status !== DelivererStatus.PENDING_VALIDATION) {
      throw new BadRequestException('Seuls les comptes en attente peuvent être validés');
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
    return this.transitionStatus(deliverer, DelivererStatus.REJECTED, reason);
  }

  async suspend(id: string, reason?: string) {
    const deliverer = await this.getNonDeleted(id);
    if (deliverer.status === DelivererStatus.SUSPENDED) {
      throw new BadRequestException('Livreur déjà suspendu');
    }
    return this.transitionStatus(deliverer, DelivererStatus.SUSPENDED, reason);
  }

  async reactivate(id: string) {
    const deliverer = await this.getNonDeleted(id);
    if (deliverer.status !== DelivererStatus.SUSPENDED) {
      throw new BadRequestException('Seuls les livreurs suspendus peuvent être réactivés');
    }
    return this.transitionStatus(deliverer, DelivererStatus.ACTIVE);
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

    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: {
        last_location: { lat: dto.lat, lng: dto.lng } as Prisma.InputJsonValue,
        last_location_at: new Date(),
        last_speed_kmh: validatedSpeed,
        last_heading_deg: dto.heading ?? null,
      },
      select: {
        id: true,
        last_location: true,
        last_location_at: true,
        last_speed_kmh: true,
        last_heading_deg: true,
      },
    });
  }

  /**
   * Mise en pause manuelle via bouton mobile. `durationMinutes` optionnel :
   * si absent → pause indéfinie jusqu'à appel de `resume()`.
   * Effet : exclut le livreur du scoring. Sort aussi de la queue FIFO.
   */
  async pauseDeliverer(delivererId: string, dto: PauseDelivererDto) {
    const pauseUntil = dto.durationMinutes
      ? new Date(Date.now() + dto.durationMinutes * 60 * 1000)
      : new Date('2099-12-31T23:59:59Z'); // pause indéfinie = date lointaine

    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: {
        pause_until: pauseUntil,
        // Sortie automatique de la queue FIFO — on ne veut plus d'offres
        last_available_at: null,
      },
      select: {
        id: true,
        pause_until: true,
        last_available_at: true,
      },
    });
  }

  /**
   * Sortie de pause (manuelle ou forcée). Clear les 2 champs de pause.
   * NE remet PAS automatiquement en queue — le livreur doit explicitement
   * appeler `markAvailable()` pour signifier « je reprends, je suis prêt ».
   */
  async resumeDeliverer(delivererId: string) {
    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: {
        pause_until: null,
        auto_pause_until: null,
      },
      select: {
        id: true,
        pause_until: true,
        auto_pause_until: true,
      },
    });
  }

  /**
   * Livreur entre dans la file d'attente FIFO — il est prêt à recevoir des offres.
   * Utilisé à la connexion initiale, en fin de pause, ou en fin de course.
   * `last_available_at = now` → il se retrouve en queue de liste (FIFO ASC).
   */
  async markAvailable(delivererId: string) {
    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: {
        last_available_at: new Date(),
        pause_until: null,
        auto_pause_until: null,
      },
      select: {
        id: true,
        last_available_at: true,
      },
    });
  }

  /**
   * Livreur sort de la file d'attente (sans être en pause stricto sensu).
   * Utilisé notamment quand une offre est acceptée → il devient "en activité".
   */
  async markUnavailable(delivererId: string) {
    return this.prisma.deliverer.update({
      where: { id: delivererId },
      data: {
        last_available_at: null,
      },
      select: {
        id: true,
        last_available_at: true,
      },
    });
  }

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
