import { Injectable, Logger } from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  DelivererStatus,
  DeliveryService,
  EntityStatus,
  OrderStatus,
  OrderType,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { SELECT_ETAT_LIVREUR, etatLivreurDepuis, peutRecevoirOffre } from 'src/modules/deliverers/helpers/disponibilite.rules';
import { DelivererScoringSettingsHelper } from 'src/modules/deliverers/helpers/deliverer-scoring-settings.helper';
import { lirePositionLivreur } from 'src/modules/deliverers/helpers/position-livreur.rules';
import { AppliLivreurService } from 'src/modules/deliverers/services/appli-livreur.service';
import { MapsService } from 'src/modules/maps/maps.service';

import { lireAttenduesEcrites, lireCommandesAttendues } from '../helpers/application-plan.rules';
import { ClientDirection, VerdictPaire } from '../helpers/direction.rules';
import { haversineMeters, ILatLng, parseOrderLatLng } from '../helpers/geo.helper';
import { journeeDeService } from '../helpers/journee-service.rules';
import { APPELS_ORDRE_PAR_PASSAGE } from '../helpers/ordre-arrets.rules';
import {
  clePaire,
  CommandePlanif,
  CoursePlanif,
  heureProgrammee,
  InstantanePlanification,
  LivreurPlanif,
  livreursAMesurer,
  pairesAEvaluer,
  pairesAOrdonner,
  pairesARegrouper,
  ReglagesPlanification,
} from '../helpers/planification.rules';
import { ReglagesPreparation } from '../helpers/preparation.rules';
import { APPELS_REGROUPEMENT_PAR_PASSAGE } from '../helpers/regroupement-tournee.rules';
import { DirectionService } from './direction.service';
import { EstimationPreparationService } from './estimation-preparation.service';

/** Une commande prête ou en cuisine plus vieille que ça (sans course) n'est plus du service en cours. */
const FRAICHEUR_COMMANDE_MS = 6 * 60 * 60 * 1000;

/** Courses ouvertes : pas encore récupérées. */
export const STATUTS_COURSE_OUVERTES: CourseStatut[] = [
  CourseStatut.PENDING_ASSIGNMENT,
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
];
/** Une course en livraison plus vieille que ça n'est plus du service en cours (oubliée). */
export const FRAICHEUR_COURSE_EN_LIVRAISON_MS = 12 * 60 * 60 * 1000;

const SELECT_COMMANDE = {
  id: true,
  reference: true,
  status: true,
  delivery_service: true,
  address: true,
  created_at: true,
  ready_at: true,
  prepared_at: true,
  estimated_preparation_time: true,
  date: true,
  time: true,
  // Prix écrit avec une commande attendue (`commandes_attendues[].montant`, 27/10).
  amount: true,
} satisfies Prisma.OrderSelect;

type LigneCommande = Prisma.OrderGetPayload<{ select: typeof SELECT_COMMANDE }>;

/** Ce que le service applique ensuite a besoin de connaître des courses (codes, restaurant). */
export interface ContexteInstantane {
  restaurant: { id: string; name: string | null; position: ILatLng | null };
  /** Code de retrait de chaque course lue. */
  codes: Map<string, string>;
  /** Refus déjà comptés sur chaque course (`max_refusal_count`). */
  refus: Map<string, number>;
}

export interface InstantaneLu {
  instantane: InstantanePlanification;
  /** Verdicts de direction mesurés (Google compris si permis), par `clePaire`. */
  verdicts: Map<string, VerdictPaire>;
  contexte: ContexteInstantane;
  /**
   * Distances par la route entre les clients des courses à ordonner (mètres,
   * par `clePaire`), lues dans le cache seulement (`matriceEntreClients`).
   */
  matrice?: Map<string, number>;
  /**
   * Distances par la route entre commandes à regrouper (mètres, par
   * `clePaire`), cache seulement (`distancesEntreCandidats`) : second avis
   * du regroupement (28/10).
   */
  entreCandidats?: Map<string, number>;
}

/** Même point à 11 m près (clé du cache routier arrondie à 4 décimales) : 0 m, rien à demander. */
const memePoint = (a: ILatLng, b: ILatLng) => a.lat.toFixed(4) === b.lat.toFixed(4) && a.lng.toFixed(4) === b.lng.toFixed(4);
const clePoints = (a: ILatLng, b: ILatLng) =>
  [a, b]
    .map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`)
    .sort()
    .join('|');
/**
 * Distance entre clients que Google n'a pas donnée : pas redemandée pendant
 * 10 min (comme l'échec retenu des Maps, `TTL.ECHEC_TRACE`), et sans prendre
 * une des 6 places d'un passage, pour que les autres paires partent.
 */
const ECHEC_ORDRE_RETENU_MS = 10 * 60 * 1000;

/**
 * LECTURE DE L'INSTANTANÉ d'un restaurant pour le planificateur v2 : commandes
 * de la flotte interne sans course (prêtes, en cuisine avec fin estimée),
 * courses ouvertes et en livraison, livreurs du restaurant (état de la règle
 * unique, position, appli, file, courses du jour), et verdicts de direction
 * des paires utiles (tracés et détours Google en cache, repli sans Google).
 *
 * Tout est relu en base à chaque passage : le planificateur n'a pas d'état.
 */
@Injectable()
export class InstantanePlanificationService {
  private readonly logger = new Logger(InstantanePlanificationService.name);
  /** Distances entre clients demandées à Google et pas encore revenues (ce serveur) : jamais deux fois en vol. */
  private readonly pairesEnVol = new Set<string>();
  /** Distances entre clients sans réponse de Google (ce serveur) : heure jusqu'à laquelle elles sont sautées. */
  private readonly pairesEnEchec = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly direction: DirectionService,
    private readonly preparation: EstimationPreparationService,
    private readonly maps: MapsService,
    private readonly reglagesLivreurs: DelivererScoringSettingsHelper,
    // Appli active ou fermée (demande du 24/10) : une appli fermée ne reçoit plus d'offre.
    private readonly appliLivreur: AppliLivreurService,
  ) {}

  async lire(
    restaurantId: string,
    maintenant: Date,
    r: ReglagesPlanification,
    google: boolean,
    reglagesPreparation?: ReglagesPreparation,
  ): Promise<InstantaneLu> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, name: true, latitude: true, longitude: true },
    });
    const position: ILatLng | null =
      restaurant?.latitude && restaurant?.longitude ? { lat: restaurant.latitude, lng: restaurant.longitude } : null;

    const [lignesCommandes, lignesCourses, lignesLivreurs] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          restaurant_id: restaurantId,
          type: OrderType.DELIVERY,
          delivery_service: DeliveryService.CHICKEN_NATION,
          status: { in: [OrderStatus.READY, OrderStatus.IN_PROGRESS] },
          entity_status: { not: EntityStatus.DELETED },
          delivery: null,
          updated_at: { gte: new Date(maintenant.getTime() - FRAICHEUR_COMMANDE_MS) },
        },
        select: SELECT_COMMANDE,
        orderBy: { created_at: 'asc' },
        take: 100,
      }),
      this.prisma.course.findMany({
        where: {
          restaurant_id: restaurantId,
          OR: [
            { statut: { in: STATUTS_COURSE_OUVERTES } },
            // En livraison : celles du service en cours seulement (retour des livreurs, départ).
            { statut: CourseStatut.IN_DELIVERY, created_at: { gte: new Date(maintenant.getTime() - FRAICHEUR_COURSE_EN_LIVRAISON_MS) } },
          ],
        },
        select: {
          id: true,
          reference: true,
          pickup_code: true,
          statut: true,
          deliverer_id: true,
          turbo_escalated_at: true,
          created_at: true,
          assigned_at: true,
          at_restaurant_at: true,
          picked_up_at: true,
          parti_at: true,
          retenue_jusqua: true,
          commandes_attendues: true,
          refusal_count: true,
          deliveries: {
            orderBy: { sequence_order: 'asc' },
            select: {
              id: true,
              statut: true,
              sequence_order: true,
              ajoutee_apres_retrait: true,
              order: { select: SELECT_COMMANDE },
            },
          },
          offer_attempts: {
            where: { status: { in: [CourseOfferStatus.PENDING, CourseOfferStatus.REFUSED, CourseOfferStatus.EXPIRED] } },
            select: { id: true, deliverer_id: true, status: true, expires_at: true, responded_at: true, forcee: true },
          },
        },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.deliverer.findMany({
        where: { restaurant_id: restaurantId, status: DelivererStatus.ACTIVE, entity_status: EntityStatus.ACTIVE },
        select: {
          ...SELECT_ETAT_LIVREUR,
          last_location: true,
          last_location_at: true,
          dernier_signal_at: true,
          protocole_appli: true,
          queue_penalty_until: true,
          queue_penalty_positions: true,
          // Joignable (socket ou jeton) : sans jeton ni socket, jamais d'offre.
          expo_push_token: true,
        },
      }),
    ]);

    // Appli de chaque livreur (socket, signe de vie) et joignabilité (socket ou
    // jeton) : l'état de la règle unique en dépend.
    const appli = await this.appliLivreur.contexte(lignesLivreurs, maintenant);

    // Courses du jour de chaque livreur (équité, 4.2).
    const journee = journeeDeService(maintenant);
    const ids = lignesLivreurs.map((l) => l.id);
    const coursesDuJour = new Map<string, number>();
    if (ids.length > 0) {
      const affectees = await this.prisma.course.findMany({
        where: {
          deliverer_id: { in: ids },
          assigned_at: { gte: journee.debut },
          statut: { notIn: [CourseStatut.CANCELLED, CourseStatut.EXPIRED] },
        },
        select: { deliverer_id: true },
      });
      for (const c of affectees) {
        if (c.deliverer_id) coursesDuJour.set(c.deliverer_id, (coursesDuJour.get(c.deliverer_id) ?? 0) + 1);
      }
    }

    // Clients (direction) : coordonnées, et tracé routier si Google est permis.
    // Courses déjà parties : coordonnées seules (retour du livreur, sans Google).
    const ouvertes = lignesCourses.filter((k) => !(k.statut === CourseStatut.IN_DELIVERY && k.parti_at));
    const aTracer = [...lignesCommandes, ...ouvertes.flatMap((k) => k.deliveries.map((d) => d.order))];
    const clients = new Map<string, ClientDirection>();
    const traces = await this.direction.clients(
      position,
      aTracer.map((c) => ({ id: c.id, address: c.address })),
      google,
    );
    for (const c of traces) clients.set(c.id, c);
    const clientDe = (o: LigneCommande): ClientDirection =>
      clients.get(o.id) ?? { id: o.id, position: parseOrderLatLng(o.address), routeMetres: null, trace: null };

    // Fin de préparation des commandes en cuisine.
    const estimations = await this.preparation.estimer(
      restaurantId,
      lignesCommandes.map((c) => ({
        id: c.id,
        status: c.status,
        prepared_at: c.prepared_at,
        estimated_preparation_time: c.estimated_preparation_time,
      })),
      maintenant,
      reglagesPreparation,
    );

    const commandePlanif = (o: LigneCommande): CommandePlanif => ({
      id: o.id,
      reference: o.reference,
      statut: o.status,
      delivery_service: o.delivery_service,
      client: clientDe(o),
      created_at: o.created_at,
      ready_at: o.ready_at,
      heure_programmee: heureProgrammee(o.date, o.time),
      preparation: estimations.get(o.id) ?? null,
      prepared_at: o.prepared_at,
      montant: typeof o.amount === 'number' && Number.isFinite(o.amount) ? o.amount : null,
    });

    const commandes = lignesCommandes.map(commandePlanif);
    const courses: CoursePlanif[] = lignesCourses.map((k) => {
      const offre = k.offer_attempts.find((o) => o.status === CourseOfferStatus.PENDING) ?? null;
      return {
        id: k.id,
        reference: k.reference,
        statut: k.statut,
        deliverer_id: k.deliverer_id,
        turbo_escalated_at: k.turbo_escalated_at,
        created_at: k.created_at,
        assigned_at: k.assigned_at,
        at_restaurant_at: k.at_restaurant_at,
        picked_up_at: k.picked_up_at,
        parti_at: k.parti_at,
        retenue_jusqua: k.retenue_jusqua,
        commandes_attendues: lireCommandesAttendues(k.commandes_attendues),
        attendues_ecrites: lireAttenduesEcrites(k.commandes_attendues),
        offre: offre
          ? { id: offre.id, deliverer_id: offre.deliverer_id, expires_at: offre.expires_at, forcee: offre.forcee }
          : null,
        // Refus : définitifs. Expirations : à part, levées par un signe de vie postérieur (règle).
        deja_sollicites: [
          ...new Set(k.offer_attempts.filter((o) => o.status === CourseOfferStatus.REFUSED).map((o) => o.deliverer_id)),
        ],
        expirees: k.offer_attempts
          .filter((o) => o.status === CourseOfferStatus.EXPIRED)
          .map((o) => ({ deliverer_id: o.deliverer_id, a: o.responded_at ?? o.expires_at })),
        livraisons: k.deliveries.map((d) => ({
          id: d.id,
          statut: d.statut,
          sequence_order: d.sequence_order,
          ajoutee_apres_retrait: d.ajoutee_apres_retrait,
          commande: commandePlanif(d.order),
        })),
      };
    });

    const livreurs: LivreurPlanif[] = lignesLivreurs.map((l) => {
      // Dernière position (temps de trajet) et dernière position précise
      // (seule à décider départ, comptoir et sac attendu).
      const lue = lirePositionLivreur(l.last_location, l.last_location_at);
      return {
        id: l.id,
        etat: etatLivreurDepuis(l, appli, maintenant),
        position: lue.position,
        position_at: l.last_location_at,
        position_sure: lue.sure,
        protocole_appli: l.protocole_appli,
        dernier_signal_at: l.dernier_signal_at,
        queue_penalty_until: l.queue_penalty_until,
        queue_penalty_positions: l.queue_penalty_positions,
        courses_du_jour: coursesDuJour.get(l.id) ?? 0,
      };
    });

    const instantane: InstantanePlanification = {
      maintenant,
      restaurant: { id: restaurantId, position },
      commandes,
      courses,
      livreurs,
    };

    // Verdicts des paires utiles : détour Google seulement si permis (cache 30 jours).
    const verdicts = new Map<string, VerdictPaire>();
    const lus = { reglages: r.direction, google, refusees: [] };
    const paires = pairesAEvaluer(instantane, r);
    const mesures = await Promise.all(
      paires.map(([a, b]) => this.direction.verdictPaire(position, a, b, lus).catch(() => null)),
    );
    paires.forEach(([a, b], i) => {
      const v = mesures[i];
      if (v) verdicts.set(clePaire(a.id, b.id), v);
    });

    // Ordre des arrêts par la route : distances entre clients, cache seulement.
    // Second avis du regroupement : distances entre commandes à regrouper, idem.
    const [matrice, entreCandidats] = await Promise.all([
      this.matriceEntreClients(instantane, google),
      this.distancesEntreCandidats(instantane, verdicts, r, google),
    ]);

    return {
      instantane,
      verdicts,
      matrice,
      entreCandidats,
      contexte: {
        restaurant: { id: restaurantId, name: restaurant?.name ?? null, position },
        codes: new Map(lignesCourses.map((k) => [k.id, k.pickup_code])),
        refus: new Map(lignesCourses.map((k) => [k.id, k.refusal_count])),
      },
    };
  }

  /**
   * Distances PAR LA ROUTE entre les clients des courses à ordonner (ordre
   * des arrêts, demande du 27/10 ; `pairesAOrdonner`) : lues dans le cache
   * routier de 30 jours seulement (`trajetEnCache`, 400 ms au plus, jamais
   * Google), dans un sens puis dans l'autre (route supposée symétrique).
   *
   * Les paires manquantes sont demandées à Google SANS ÊTRE ATTENDUES, si le
   * réglage le permet : 6 au plus par passage, du client le plus proche du
   * restaurant vers le plus lointain, jamais deux fois en vol, une paire sans
   * réponse de Google sautée 10 min sans prendre de place. Leur résultat
   * entre au cache et sert au passage suivant. Ne lève jamais : une panne
   * donne une matrice vide (le calcul d'aujourd'hui).
   */
  async matriceEntreClients(instantane: InstantanePlanification, google: boolean): Promise<Map<string, number>> {
    const matrice = new Map<string, number>();
    const paires = pairesAOrdonner(instantane);
    if (paires.length === 0) return matrice;
    try {
      const lues = await Promise.all(
        paires.map(async ([a, b]) => {
          const pa = a.position!;
          const pb = b.position!;
          if (memePoint(pa, pb)) return 0;
          return (await this.maps.trajetEnCache(pa, pb)) ?? (await this.maps.trajetEnCache(pb, pa));
        }),
      );
      const manquantes: [ILatLng, ILatLng][] = [];
      paires.forEach(([a, b], i) => {
        const m = lues[i];
        if (typeof m === 'number' && Number.isFinite(m) && m >= 0) matrice.set(clePaire(a.id, b.id), m);
        else manquantes.push([a.position!, b.position!]);
      });
      if (google) this.demanderDistances(manquantes, 'ordre', APPELS_ORDRE_PAR_PASSAGE);
    } catch (err) {
      this.logger.warn(`Distances entre clients indisponibles : ${(err as Error)?.message ?? err}`);
      matrice.clear();
    }
    return matrice;
  }

  /**
   * Distances PAR LA ROUTE entre commandes à regrouper (second avis, retour
   * du client du 28/10 ; `pairesARegrouper` : paires refusées par la
   * direction, pas perdues d'avance, 60 au plus) : lues dans le cache routier
   * de 30 jours seulement, dans un sens puis dans l'autre. Elles vont dans
   * une table à part que seul le second avis lit.
   *
   * Les manquantes sont demandées à Google SANS ÊTRE ATTENDUES, si le réglage
   * le permet : 6 au plus par passage (en plus des 6 de l'ordre des arrêts),
   * comptées à part (`regroupement_route`) dans le plafond quotidien, jamais
   * deux fois en vol, une paire sans réponse sautée 10 min sans prendre de
   * place. Le passage suivant (10 s) les trouve en cache. Ne lève jamais.
   */
  async distancesEntreCandidats(
    instantane: InstantanePlanification,
    verdicts: ReadonlyMap<string, VerdictPaire>,
    r: ReglagesPlanification,
    google: boolean,
  ): Promise<Map<string, number>> {
    const distances = new Map<string, number>();
    try {
      const paires = pairesARegrouper(instantane, verdicts, r);
      if (paires.length === 0) return distances;
      const lues = await Promise.all(
        paires.map(async ([a, b]) => {
          const pa = a.position!;
          const pb = b.position!;
          if (memePoint(pa, pb)) return 0;
          return (await this.maps.trajetEnCache(pa, pb)) ?? (await this.maps.trajetEnCache(pb, pa));
        }),
      );
      const manquantes: [ILatLng, ILatLng][] = [];
      paires.forEach(([a, b], i) => {
        const m = lues[i];
        if (typeof m === 'number' && Number.isFinite(m) && m >= 0) distances.set(clePaire(a.id, b.id), m);
        else manquantes.push([a.position!, b.position!]);
      });
      if (google) this.demanderDistances(manquantes, 'regroupement', APPELS_REGROUPEMENT_PAR_PASSAGE);
    } catch (err) {
      this.logger.warn(`Distances entre commandes à regrouper indisponibles : ${(err as Error)?.message ?? err}`);
      distances.clear();
    }
    return distances;
  }

  /**
   * Lance les appels Google manquants sans les attendre (`max` au plus, 6,
   * jamais deux fois en vol). Une paire sans réponse de Google est sautée
   * 10 min sans compter parmi les places : sinon, Google lent, les mêmes
   * paires en échec prenaient toutes les places et celles des autres courses
   * n'étaient jamais demandées. `pour` : la fonction comptée (`ordre_arrets`
   * ou `regroupement_route`).
   */
  private demanderDistances(paires: readonly [ILatLng, ILatLng][], pour: 'ordre' | 'regroupement', max: number): void {
    const maintenant = Date.now();
    for (const [cle, jusqua] of this.pairesEnEchec) if (jusqua <= maintenant) this.pairesEnEchec.delete(cle);
    let lancees = 0;
    for (const [origine, destination] of paires) {
      if (lancees >= max) return;
      const cle = clePoints(origine, destination);
      if (this.pairesEnVol.has(cle) || this.pairesEnEchec.has(cle)) continue;
      this.pairesEnVol.add(cle);
      lancees++;
      void Promise.resolve()
        .then(() =>
          this.maps.itineraireRoutier(
            { originLat: origine.lat, originLng: origine.lng, destLat: destination.lat, destLng: destination.lng },
            { pour },
          ),
        )
        .catch(() => null)
        .then((itineraire) => {
          if (!itineraire) this.pairesEnEchec.set(cle, Date.now() + ECHEC_ORDRE_RETENU_MS);
        })
        .finally(() => this.pairesEnVol.delete(cle));
    }
  }

  /**
   * Temps Google jusqu'au restaurant, si `deliverer.travel_time_ranking` = 1
   * et qu'au moins deux livreurs LIBRES à position fraîche (hors comptoir)
   * sont à départager : un seul appel pour TOUS les livreurs dont le temps se
   * mesure (`livreursAMesurer` : libres, en course, offre en attente). La règle
   * n'emploie les temps Google que s'ils sont connus pour tous ceux-là (jamais
   * de mélange avec le vol d'oiseau) : demander les seuls libres payait un
   * appel jeté dès qu'un livreur en course envoyait sa position. Sinon rien.
   *
   * Appelé seulement quand le plan propose une course (le passage de 10 s ne
   * paie pas un appel Google pour rien) ; le plan est alors recalculé.
   *
   * @returns vrai si des temps ont été ajoutés pour tous les livreurs mesurés.
   */
  async completerTempsGoogle(instantane: InstantanePlanification, r: ReglagesPlanification): Promise<boolean> {
    const { livreurs, maintenant } = instantane;
    const restaurant = instantane.restaurant.position;
    if (!restaurant) return false;
    try {
      const reglages = await this.reglagesLivreurs.load();
      if (!reglages.travelTimeRanking) return false;
      const aMesurer = livreursAMesurer(livreurs, restaurant, r, maintenant);
      const libres = aMesurer.filter(
        (l) => peutRecevoirOffre(l.etat, maintenant).ok && haversineMeters(l.position!, restaurant) > 0,
      );
      if (libres.length < 2) return false;
      const temps = await this.maps.getTravelTimes(
        aMesurer.map((l) => ({ latitude: l.position!.lat, longitude: l.position!.lng })),
        { latitude: restaurant.lat, longitude: restaurant.lng },
      );
      if (!temps) return false;
      const valides = aMesurer.map((_, i) => temps[i]);
      // Un temps manquant : rien n'est retenu (la règle repasserait tout le monde au vol d'oiseau).
      if (!valides.every((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0)) return false;
      aMesurer.forEach((l, i) => {
        l.secondes_google = valides[i] as number;
      });
      return true;
    } catch (err) {
      this.logger.warn(`Temps de trajet des livreurs indisponibles : ${(err as Error)?.message}`);
    }
    return false;
  }
}
