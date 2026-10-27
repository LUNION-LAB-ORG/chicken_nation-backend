import { OrderDepartureNotifierService } from 'src/common/services/order-departure-notifier.service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CourseStatut, DeliveryStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import { lirePositionLivreur } from 'src/modules/deliverers/helpers/position-livreur.rules';
import { MapsService } from 'src/modules/maps/maps.service';
import type { DelivererLocationUpdatedPayload } from 'src/modules/deliverers/events/deliverer.event';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { CourseChannels } from '../enums/course-channels';
import { parseOrderLatLng } from '../helpers/geo.helper';
import type { DeliveryStatutChangedPayload } from '../interfaces/course-event.interface';

/**
 * Suivi de livraison TEMPS RÉEL côté CLIENT (app cliente).
 *
 * Ce service est le pont entre le monde "livreur/course" (interne) et le
 * monde "client". Il relaie deux choses vers la room `customer_{id}` :
 *
 *   1. `delivery:location` — la position GPS live du livreur, à haute fréquence
 *      pendant que la course est en cours (IN_DELIVERY). C'est ce qui anime la
 *      carte type Uber Eats / Yango côté client.
 *
 *   2. `delivery:statut:changed` — chaque transition de SA livraison
 *      (PENDING → IN_ROUTE → ARRIVED → DELIVERED…), pour que l'app rafraîchisse
 *      l'état (message "votre livreur arrive", bascule de la carte, etc.).
 *
 * POURQUOI ici (module course) et pas dans le module deliverers :
 *   La résolution "quel(s) client(s) doit recevoir cette position ?" dépend du
 *   graphe Course → Delivery → Order → Customer, qui appartient au domaine
 *   course. Le module deliverers se contente d'émettre l'event interne
 *   `deliverer:location:updated` (haute fréquence) ; on l'écoute ici.
 *
 * Le relais inter-instances est assuré par l'adaptateur Redis socket.io
 * (cf. RedisIoAdapter) : livreur et client peuvent être sur 2 instances
 * différentes, l'event traverse quand même.
 */
@Injectable()
export class DeliveryTrackingService {
  private readonly logger = new Logger(DeliveryTrackingService.name);

  /** Livraisons "vivantes" : le client doit voir le livreur tant qu'il n'a pas reçu sa commande. */
  private static readonly NON_TERMINAL: DeliveryStatut[] = [
    DeliveryStatut.PENDING,
    DeliveryStatut.IN_ROUTE,
    DeliveryStatut.ARRIVED,
  ];

  /**
   * Dernier calcul d'ETA par course : { à quand, ETA en secondes par commande }.
   * Le GPS remonte toutes les 60 s ; recalculer un itinéraire à chaque ping
   * coûterait cher chez Google pour un gain nul (le trafic ne change pas en
   * une minute). Cache mémoire volontaire : le perdre au redémarrage est sans
   * conséquence, le calcul suivant le reconstruit.
   */
  private readonly etaCache = new Map<
    string,
    {
      calculeA: number;
      parCommande: Map<string, number>;
      /** Commandes de la tournée au moment du calcul : un ajout ou un retrait le périme. */
      signature: string;
      /** Google n'a rien donné (muet, lent, refus) : nouvel essai après `ETA_ECHEC_TTL_MS`. */
      echec: boolean;
    }
  >();

  /**
   * Échec de Google retenu 1 min. L'appli livreur envoie une position toutes
   * les 14 s même à l'arrêt (et plus souvent en roulant) : sans cela, chaque
   * position d'une tournée relançait Google tant qu'il échouait, avec son
   * délai de 2,5 s.
   */
  private static readonly ETA_ECHEC_TTL_MS = 60_000;

  /** Au-delà, les calculs périmés (courses terminées) sont oubliés. */
  private static readonly ETA_CACHE_TAILLE = 200;

  /**
   * Fraîcheur de l'ETA : 5 minutes. Le client n'a pas besoin d'un compte à
   * rebours à la seconde, et recalculer un itinéraire à chaque ping GPS
   * coûterait cher chez Google pour un gain nul. Au-delà, on recalcule.
   */
  private static readonly ETA_TTL_MS = 5 * 60_000;

  /**
   * Course partie : au démarrage d'une livraison, l'heure d'arrivée part de
   * la dernière position du livreur si elle a moins de 2 min (il est chez le
   * client précédent, pas au restaurant).
   */
  private static readonly POSITION_DEPART_FRAICHE_MS = 2 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appGateway: AppGateway,
    private readonly maps: MapsService,
    private readonly departNotifier: OrderDepartureNotifierService,
  ) {}

  // ── 1. Position live livreur → client(s) ───────────────────────────────────

  /**
   * Reçoit chaque remontée GPS du livreur (haute fréquence pendant la livraison)
   * et la relaie au(x) client(s) dont la livraison est en cours dans la course
   * active de ce livreur.
   *
   * Robuste : un livreur en pause / sans course active ne déclenche aucune
   * émission (résolution = liste vide). Les erreurs sont loggées sans casser le
   * flux GPS (l'event est déjà fire-and-forget côté émetteur).
   */
  @OnEvent(DelivererChannels.DELIVERER_LOCATION_UPDATED)
  async onDelivererLocation(payload: DelivererLocationUpdatedPayload): Promise<void> {
    try {
      const targets = await this.resolveActiveCustomers(payload.delivererId);
      if (targets.length === 0) return;

      // Heure d'arrivée par client. Tient compte du trafic ET des arrêts chez
      // les clients précédents : sur une tournée, le 2e livré attend aussi que
      // le 1er soit servi. Best-effort — une panne Google ne coupe jamais le
      // suivi de position.
      const etas = await this.calculerEtas(payload.delivererId, {
        latitude: payload.lat,
        longitude: payload.lng,
      }).catch(() => new Map<string, number>());

      for (const t of targets) {
        const etaSeconds = etas.get(t.orderId);
        this.appGateway.emitToUser(
          t.customerId,
          'customer',
          CourseChannels.CUSTOMER_DELIVERY_LOCATION,
          {
            orderId: t.orderId,
            delivererId: payload.delivererId,
            lat: payload.lat,
            lng: payload.lng,
            heading: payload.heading,
            speedKmh: payload.speedKmh,
            deliveryStatut: t.deliveryStatut,
            /** Minutes avant l'arrivée chez CE client. `null` si indisponible. */
            etaMin: etaSeconds != null ? Math.max(1, Math.round(etaSeconds / 60)) : null,
            ts: payload.ts,
          },
        );
      }
    } catch (err) {
      this.logger.warn(
        `Relais position livreur ${payload.delivererId} échoué: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Résout les clients à notifier pour un livreur donné : course active
   * (IN_DELIVERY) → livraisons non terminales → client de chaque order.
   *
   * Requête indexée sur `Course(deliverer_id, statut)` + retour de quelques
   * lignes max (livraisons d'une seule course) ⇒ assez légère pour être appelée
   * à chaque ping GPS sans cache.
   */
  /**
   * ETA par commande pour la tournée en cours.
   *
   * UN SEUL appel Google pour toute la tournée : origine = position du livreur,
   * étapes = les livraisons restantes dans l'ordre. Les durées cumulées des
   * segments donnent l'heure d'arrivée de chaque client, et on ajoute le temps
   * d'arrêt chez les clients qui le précèdent (il attend aussi qu'ils soient
   * servis). Résultat mis en cache `ETA_TTL_MS` pour ne pas rappeler Google à
   * chaque ping GPS.
   */
  private async calculerEtas(
    delivererId: string,
    position: { latitude: number; longitude: number },
    options: { garder?: boolean } = {},
  ): Promise<Map<string, number>> {
    const garder = options.garder ?? true;
    const course = await this.prisma.course.findFirst({
      where: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
      select: {
        id: true,
        deliveries: {
          where: { statut: { in: DeliveryTrackingService.NON_TERMINAL } },
          orderBy: { sequence_order: 'asc' },
          select: { order: { select: { id: true, address: true } } },
        },
      },
    });
    if (!course || course.deliveries.length === 0) return new Map();

    const signature = course.deliveries.map((d) => d.order.id).join(',');
    const frais = this.etaCache.get(course.id);
    const ttl = frais?.echec ? DeliveryTrackingService.ETA_ECHEC_TTL_MS : DeliveryTrackingService.ETA_TTL_MS;
    if (frais && frais.signature === signature && Date.now() - frais.calculeA < ttl) {
      return frais.parCommande;
    }

    // Arrêts géolocalisables uniquement : une adresse sans coordonnées ne peut
    // pas entrer dans l'itinéraire, on la laisse simplement sans ETA.
    // `parseOrderLatLng` renvoie {lat,lng}, l'API Maps attend {latitude,longitude} :
    // on normalise ici une bonne fois pour toutes.
    const etapes = course.deliveries
      .map((d) => {
        const c = parseOrderLatLng(d.order.address);
        return c
          ? { orderId: d.order.id, coord: { latitude: c.lat, longitude: c.lng } }
          : null;
      })
      .filter(
        (e): e is { orderId: string; coord: { latitude: number; longitude: number } } =>
          e !== null,
      );
    if (etapes.length === 0) return new Map();

    const derniere = etapes[etapes.length - 1].coord;
    const directions = await this.maps
      .getDirections({
        originLat: position.latitude,
        originLng: position.longitude,
        destLat: derniere.latitude,
        destLng: derniere.longitude,
        waypoints: etapes.slice(0, -1).map((e) => e.coord),
      })
      .catch(() => null);
    if (!directions || directions.legs.length === 0) {
      if (garder) this.retenirEtas(course.id, { calculeA: Date.now(), parCommande: new Map(), signature, echec: true });
      return new Map();
    }

    const parCommande = new Map<string, number>();
    // Temps d'arrêt appliqué AVANT chaque client, déduit du calcul backend
    // (arrêts totaux répartis sur les clients intermédiaires).
    const arretUnitaire =
      etapes.length > 1 ? (directions.stopsSeconds ?? 0) / (etapes.length - 1) : 0;

    let cumul = 0;
    etapes.forEach((etape, i) => {
      cumul += directions.legs[i]?.durationSeconds ?? 0;
      // Le i-ème client attend aussi la remise chez les i clients précédents.
      parCommande.set(etape.orderId, Math.round(cumul + i * arretUnitaire));
    });

    if (garder) this.retenirEtas(course.id, { calculeA: Date.now(), parCommande, signature, echec: false });
    return parCommande;
  }

  /** Garde un calcul ; au-delà de `ETA_CACHE_TAILLE` courses, les calculs périmés sont oubliés. */
  private retenirEtas(
    courseId: string,
    calcul: { calculeA: number; parCommande: Map<string, number>; signature: string; echec: boolean },
  ): void {
    this.etaCache.set(courseId, calcul);
    if (this.etaCache.size <= DeliveryTrackingService.ETA_CACHE_TAILLE) return;
    const limite = Date.now() - DeliveryTrackingService.ETA_TTL_MS;
    for (const [id, c] of this.etaCache) {
      if (c.calculeA < limite) this.etaCache.delete(id);
    }
  }

  /**
   * ETA d'un client au moment où la livraison démarre, sans attendre le
   * premier relevé GPS. Course pas encore partie : depuis le restaurant, exact
   * à cet instant. Course partie (2e arrêt, livraison reprise après « Plus
   * tard ») : depuis la dernière position du livreur si elle a moins de
   * 2 min ; sinon depuis le restaurant, et ce calcul n'est pas gardé (la
   * position suivante recalcule, au lieu de garder 5 min une heure fausse).
   */
  private async etaAuDepart(courseId: string, orderId: string): Promise<number | null> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        deliverer_id: true,
        parti_at: true,
        restaurant: { select: { latitude: true, longitude: true } },
        deliverer: { select: { last_location: true, last_location_at: true } },
      },
    });
    if (!course?.restaurant?.latitude || !course.restaurant.longitude || !course.deliverer_id) {
      return null;
    }
    let origine = { latitude: course.restaurant.latitude, longitude: course.restaurant.longitude };
    let garder = true;
    if (course.parti_at) {
      const lue = lirePositionLivreur(course.deliverer?.last_location, course.deliverer?.last_location_at);
      const fraiche =
        !!lue.position &&
        !!lue.position_at &&
        Date.now() - lue.position_at.getTime() < DeliveryTrackingService.POSITION_DEPART_FRAICHE_MS;
      if (fraiche) origine = { latitude: lue.position!.lat, longitude: lue.position!.lng };
      else garder = false;
    }
    const etas = await this.calculerEtas(course.deliverer_id, origine, { garder });
    const seconds = etas.get(orderId);
    return seconds != null ? Math.max(1, Math.round(seconds / 60)) : null;
  }

  private async resolveActiveCustomers(
    delivererId: string,
  ): Promise<Array<{ customerId: string; orderId: string; deliveryStatut: DeliveryStatut }>> {
    const course = await this.prisma.course.findFirst({
      where: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
      select: {
        deliveries: {
          where: { statut: { in: DeliveryTrackingService.NON_TERMINAL } },
          select: {
            statut: true,
            order: { select: { id: true, customer_id: true } },
          },
        },
      },
    });

    return (course?.deliveries ?? [])
      .filter((d) => Boolean(d.order?.customer_id))
      .map((d) => ({
        customerId: d.order.customer_id,
        orderId: d.order.id,
        deliveryStatut: d.statut,
      }));
  }

  // ── 2. Statut de la livraison → client ─────────────────────────────────────

  /**
   * Relaie chaque transition de statut d'une Delivery vers SON client.
   * (Le backoffice reçoit déjà cet event via CourseListenerService ; ici on
   * cible le client concerné, room `customer_{id}`.)
   *
   * L'app cliente s'en sert pour : invalider/rafraîchir le détail commande,
   * afficher "votre livreur est en route / arrivé", basculer ou retirer la carte.
   */
  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  async onDeliveryStatutChanged(payload: DeliveryStatutChangedPayload): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: payload.delivery.order_id },
        select: { id: true, customer_id: true },
      });
      if (!order?.customer_id) return;

      // Au DÉPART de la livraison, le client doit voir son heure d'arrivée tout
      // de suite, sans attendre le premier ping GPS (jusqu'à une minute plus
      // tard). Le livreur étant encore au restaurant, on prend le restaurant
      // comme point de départ : c'est exact à cet instant précis.
      let etaMin: number | null = null;
      if (payload.new_statut === DeliveryStatut.IN_ROUTE) {
        etaMin = await this.etaAuDepart(payload.course_id, order.id).catch(() => null);

        // Client sans application : c'est ici qu'il reçoit son code de
        // récupération, par WhatsApp. Volontairement non attendu, pour ne pas
        // retarder l'événement temps réel des clients qui, eux, ont l'app.
        // Livraison reprise après « Plus tard » : le code a déjà été envoyé
        // (`reglePlusTard` refuse de passer un client jamais parti vers lui).
        if (!payload.delivery?.reportee_at) void this.departNotifier.notifier(order.id);
      }

      this.appGateway.emitToUser(
        order.customer_id,
        'customer',
        CourseChannels.CUSTOMER_DELIVERY_STATUT_CHANGED,
        {
          orderId: order.id,
          statut: payload.new_statut,
          previousStatut: payload.previous_statut,
          courseId: payload.course_id,
          /** Minutes avant l'arrivée. Renseigné au départ de la livraison. */
          etaMin,
          ts: new Date().toISOString(),
        },
      );
    } catch (err) {
      this.logger.warn(
        `Relais statut delivery ${payload.delivery.id} échoué: ${(err as Error).message}`,
      );
    }
  }
}
