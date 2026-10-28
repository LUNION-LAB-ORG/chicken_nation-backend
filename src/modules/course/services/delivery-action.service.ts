import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatut,
  DeliveryFailureReason,
  DeliveryStatut,
  OrderStatus,
  PaiementStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
import {
  libelleEncaissements,
  normaliserEncaissements,
} from 'src/turbo/constantes/turbo.constante';

import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { RateCustomerDto } from '../dto/rate-customer.dto';
import { CourseEvent } from '../events/course.event';
import { LivraisonAnnuleeParLivreurPayload, OrigineAnnulationLivraison } from '../events/livraison-annulee.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { MESSAGE_DEPART_AVANT_RETRAIT } from '../helpers/depart.rules';
import { DecisionPlusTard, MESSAGE_CLIENT_EN_COURS, reglePlusTard } from '../helpers/plus-tard.rules';
import { DepartCourseService } from './depart-course.service';
import { DispatchJournalService } from './dispatch-journal.service';

/**
 * Livraison encore à faire : le livreur peut la passer en échec. PENDING
 * compris : la livraison suivante d'une tournée attend que l'appli la
 * démarre, et le livreur doit pouvoir signaler un problème si ce démarrage
 * n'est pas passé.
 */
const LIVRAISON_A_FAIRE: DeliveryStatut[] = [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];

const messageStatutAttendu = (attendus: DeliveryStatut[], actuel: DeliveryStatut) =>
  `Statut delivery attendu ${attendus.join(' ou ')}, actuel ${actuel}`;

/**
 * Refus d'une action du livreur sur une livraison, dans l'ordre des routes :
 * inconnue (404), livraison d'un autre livreur (403, avant tout état), course
 * pas en livraison, statut pas attendu (400). `null` : rien à refuser.
 */
function refusLivraison(
  lue: { statut: DeliveryStatut; course: { deliverer_id: string | null; statut: CourseStatut } } | null,
  delivererId: string,
  attendus: DeliveryStatut[],
): HttpException | null {
  if (!lue) return new NotFoundException('Delivery non trouvée');
  if (lue.course.deliverer_id !== delivererId) {
    return new ForbiddenException("Cette livraison ne vous est pas affectée");
  }
  if (lue.course.statut !== CourseStatut.IN_DELIVERY) {
    return new BadRequestException('La course doit être en phase IN_DELIVERY');
  }
  if (!attendus.includes(lue.statut)) return new BadRequestException(messageStatutAttendu(attendus, lue.statut));
  return null;
}

/** Commandes que la remise ne réécrit plus : terminée, collectée, déjà annulée. */
const COMMANDES_CLOSES: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.COLLECTED, OrderStatus.CANCELLED];

/**
 * Commande pas encore remise au livreur (le sac est au comptoir, ajoutée
 * après le retrait par exemple) : sa livraison ne peut pas être annulée par
 * le livreur, 409 « Commande pas encore remise. ».
 */
const COMMANDE_PAS_REMISE: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PROGRESS,
  OrderStatus.READY,
];

/** Livraison commencée : en route vers son client, ou chez lui. */
const LIVRAISON_COMMENCEE: DeliveryStatut[] = [DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];

/** Livraison terminée : livrée, en échec ou annulée. */
const LIVRAISON_TERMINEE: DeliveryStatut[] = [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED];

/** Plus rien à livrer dans la course : elle peut se terminer. */
const toutesTerminees = (livraisons: readonly { statut: DeliveryStatut }[]) =>
  livraisons.every((l) => LIVRAISON_TERMINEE.includes(l.statut));

/** Ce que « Plus tard » relit de la course, sous son verrou. */
const SELECT_PLUS_TARD = {
  id: true,
  reference: true,
  restaurant_id: true,
  deliverer_id: true,
  statut: true,
  parti_at: true,
  deliveries: {
    select: {
      id: true,
      order_id: true,
      statut: true,
      sequence_order: true,
      reportee_at: true,
      arrived_at: true,
      in_route_at: true,
      ajoutee_apres_retrait: true,
      order: { select: { status: true, reference: true } },
    },
  },
} satisfies Prisma.CourseSelect;

type CoursePlusTardLue = Prisma.CourseGetPayload<{ select: typeof SELECT_PLUS_TARD }>;

/** La livraison a changé entre la règle et l'écriture (autre geste au même instant) : relue après l'annulation. */
class ReportChange extends Error {}

/** Refus de la règle « Plus tard », avec le code HTTP du contrat. */
function exceptionPlusTard(d: Extract<DecisionPlusTard, { type: 'REFUS' }>): HttpException {
  switch (d.code) {
    case 404:
      return new NotFoundException(d.message);
    case 403:
      return new ForbiddenException(d.message);
    case 409:
      return new ConflictException(d.message);
    default:
      return new BadRequestException(d.message);
  }
}

/**
 * Service : transitions de statut sur les Delivery individuelles.
 * Auto-complétion de la Course parent quand toutes les Delivery sont terminées.
 */
@Injectable()
export class DeliveryActionService {
  private readonly logger = new Logger(DeliveryActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly queueService: DelivererQueueService,
    // P-push livreur : push "Course terminée — bravo !" à la fin
    private readonly pushService: DelivererPushService,
    // Cloche staff « encaissement à confirmer » (livraison non payée)
    private readonly notificationsSender: NotificationsSenderService,
    // Planificateur v2 : démarrer une livraison, c'est quitter le restaurant.
    private readonly depart?: DepartCourseService,
    // Journal de la diffusion : « Plus tard » (LIVRAISON_REPORTEE).
    private readonly journal?: DispatchJournalService,
  ) {}

  /**
   * Le livreur démarre une livraison vers ce client (PENDING → IN_ROUTE).
   * Déjà en route (démarrée par le serveur au départ du restaurant, ou appel
   * répété) : rendue telle quelle, sans erreur. Commande ajoutée après le
   * retrait et pas encore remise : 409. Course pas encore partie : le départ
   * est enregistré d'abord (DepartCourseService).
   *
   * Jamais deux livraisons en route (27/10) : une AUTRE livraison de la course
   * en route ou chez son client, 409 « Termine d'abord le client en cours. ».
   * La course est verrouillée le temps du démarrage (même ligne que « Plus
   * tard », qui démarre la suivante) : un seul des deux passe.
   */
  async startDelivery(deliveryId: string, delivererId: string) {
    const delivery = await this.assertOwned(deliveryId, delivererId, [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE]);
    if (delivery.statut === DeliveryStatut.IN_ROUTE) return this.lireSansCode(deliveryId);

    await this.depart?.avantDemarrageLivraison(delivery);

    const demarree = await this.prisma.$transaction(async (tx) => {
      await tx.course.updateMany({
        where: { id: delivery.course_id, deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
        data: { updated_at: new Date() },
      });
      const enCours = await tx.delivery.count({
        where: { course_id: delivery.course_id, id: { not: deliveryId }, statut: { in: LIVRAISON_COMMENCEE } },
      });
      if (enCours > 0) throw new ConflictException(MESSAGE_CLIENT_EN_COURS);
      // Conditionnée : le serveur a pu la démarrer au même instant (départ).
      const { count } = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          statut: DeliveryStatut.PENDING,
          course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
        },
        data: { statut: DeliveryStatut.IN_ROUTE, in_route_at: new Date() },
      });
      return count === 1;
    });
    // Le livreur ne doit JAMAIS lire le code : c'est le client qui le lui
    // dicte, et c'est ce qui prouve la remise.
    const updated = await this.lireSansCode(deliveryId);
    if (!demarree) return updated;

    await this.emitDeliveryStatut(updated, delivery.statut);
    return updated;
  }

  /**
   * « PLUS TARD » (demande du 27/10) : le livreur passe ce client (absent,
   * injoignable), livre les autres, puis revient sur lui en fin de tournée.
   * Règle pure `reglePlusTard` (refus, rejeu, nouvel ordre), une seule
   * transaction :
   *  1. la course est verrouillée (mise à jour conditionnelle : ce livreur,
   *     en livraison, partie), comme le détachement d'une commande ; sinon
   *     elle est relue et le refus dit pourquoi ;
   *  2. les livraisons sont relues sous ce verrou, la règle décide ;
   *  3. la livraison repasse « en attente », son arrivée est effacée, la date
   *     du report notée (une seule fois : `reportee_at` nul exigé) ;
   *  4. les rangs sont renumérotés de 1 à N, en deux temps (contrainte unique) ;
   *  5. la suivante démarre.
   * Ensuite : journal LIVRAISON_REPORTEE, deux `deliveryStatutChanged` (la
   * reportée, puis la suivante), et la course complète rendue, comme
   * `me/current` (sans le code du client). Aucun appel Google, aucune
   * notification ; l'encaissement et le code du client ne changent pas.
   * Rejeu (déjà reportée, encore en attente) : la course telle quelle.
   */
  async reporterLivraison(deliveryId: string, delivererId: string, maintenant = new Date()) {
    const lue = await this.prisma.delivery.findUnique({ where: { id: deliveryId }, select: { course_id: true } });
    if (!lue) throw new NotFoundException('Delivery non trouvée');
    const courseId = lue.course_id;

    let issue: { decision: Extract<DecisionPlusTard, { type: 'REPORTER' }>; course: CoursePlusTardLue; demarree: boolean } | null;
    try {
      issue = await this.prisma.$transaction(async (tx) => {
        const verrou = await tx.course.updateMany({
          where: { id: courseId, deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY, parti_at: { not: null } },
          data: { updated_at: maintenant },
        });
        const course = await tx.course.findUnique({ where: { id: courseId }, select: SELECT_PLUS_TARD });
        const decision = reglePlusTard({ livraisonId: deliveryId, delivererId, course, maintenant });
        if (decision.type === 'REFUS') throw exceptionPlusTard(decision);
        if (decision.type === 'REJEU') return null;
        if (verrou.count !== 1 || !course) throw new BadRequestException('La course doit être en phase IN_DELIVERY');

        const reportee = await tx.delivery.updateMany({
          where: {
            id: deliveryId,
            course_id: courseId,
            statut: { in: [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED] },
            reportee_at: null,
          },
          data: { statut: DeliveryStatut.PENDING, arrived_at: null, reportee_at: maintenant },
        });
        if (reportee.count !== 1) throw new ReportChange();

        const max = Math.max(0, ...course.deliveries.map((l) => l.sequence_order));
        await tx.delivery.updateMany({ where: { course_id: courseId }, data: { sequence_order: { increment: max } } });
        for (const [id, rang] of decision.rangs) {
          await tx.delivery.updateMany({ where: { id, course_id: courseId }, data: { sequence_order: rang } });
        }

        let demarree = false;
        if (decision.suivante.a_demarrer) {
          const suivante = await tx.delivery.updateMany({
            where: { id: decision.suivante.id, course_id: courseId, statut: DeliveryStatut.PENDING },
            data: { statut: DeliveryStatut.IN_ROUTE, in_route_at: maintenant },
          });
          demarree = suivante.count === 1;
        }
        return { decision, course, demarree };
      });
    } catch (err) {
      if (!(err instanceof ReportChange)) throw err;
      // Un autre geste est passé au même instant (double toucher, remise) :
      // rien n'a été écrit, la règle relit l'état et dit pourquoi.
      const relue = await this.prisma.course.findUnique({ where: { id: courseId }, select: SELECT_PLUS_TARD });
      const decision = reglePlusTard({ livraisonId: deliveryId, delivererId, course: relue, maintenant });
      if (decision.type === 'REFUS') throw exceptionPlusTard(decision);
      if (decision.type === 'REPORTER') throw new BadRequestException('Statut delivery changé entre-temps');
      issue = null;
    }

    if (issue) await this.annoncerReport(issue.decision, issue.course, issue.demarree, delivererId);
    return this.prisma.course.findUniqueOrThrow({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
  }

  /** Après « Plus tard » : journal, puis la reportée et la suivante à tous les écrans (sans notification). */
  private async annoncerReport(
    decision: Extract<DecisionPlusTard, { type: 'REPORTER' }>,
    course: CoursePlusTardLue,
    demarree: boolean,
    delivererId: string,
  ): Promise<void> {
    const avant = new Map(course.deliveries.map((l) => [l.id, l]));
    const reportee = avant.get(decision.reportee.id);
    const suivante = avant.get(decision.suivante.id);
    await this.journal?.ecrire({
      type: 'LIVRAISON_REPORTEE',
      source: 'livreur',
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: delivererId,
      order_id: reportee?.order_id ?? null,
      details: {
        commande: reportee?.order.reference ?? null,
        statut_avant: decision.reportee.statut_avant,
        rang_avant: decision.reportee.rang_avant,
        rang_apres: decision.reportee.rang_apres,
        arrivee_avant: decision.reportee.arrivee_avant?.toISOString() ?? null,
        suivante: suivante?.order.reference ?? null,
      },
    });
    const reporteeLue = await this.lireSansCode(decision.reportee.id);
    await this.emitDeliveryStatut(reporteeLue, decision.reportee.statut_avant);
    if (demarree) {
      const suivanteLue = await this.lireSansCode(decision.suivante.id);
      await this.emitDeliveryStatut(suivanteLue, DeliveryStatut.PENDING);
    }
  }

  /** Livraison relue sans le code du client. */
  private lireSansCode(deliveryId: string) {
    return this.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId }, omit: { delivery_pin: true } });
  }

  /**
   * Livreur arrivé à l'adresse client (IN_ROUTE → ARRIVED). Écriture
   * CONDITIONNÉE : si le serveur déclare l'arrivée d'après la position au
   * même instant, un seul des deux passe (le client n'est prévenu qu'une fois).
   */
  async markArrived(deliveryId: string, delivererId: string) {
    const delivery = await this.assertOwned(deliveryId, delivererId, [DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED]);
    // Arrivée déjà déclarée (par le serveur d'après la position, ou deux
    // touchers) : réponse normale, rien ne change.
    if (delivery.statut === DeliveryStatut.ARRIVED) return this.lireSansCode(deliveryId);

    const { count } = await this.prisma.delivery.updateMany({
      where: {
        id: deliveryId,
        statut: DeliveryStatut.IN_ROUTE,
        course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
      },
      data: { statut: DeliveryStatut.ARRIVED, arrived_at: new Date() },
    });
    if (count !== 1) return this.livraisonChangee(deliveryId, DeliveryStatut.ARRIVED);
    // Le livreur ne doit JAMAIS lire le code : c'est le client qui le lui
    // dicte, et c'est ce qui prouve la remise. Sans cette omission, la
    // reponse de la route lui donnait de quoi valider sans voir personne.
    const updated = await this.lireSansCode(deliveryId);

    await this.emitDeliveryStatut(updated, delivery.statut);
    return updated;
  }

  /**
   * Confirmation de livraison via PIN client (ARRIVED → DELIVERED).
   * Valide le PIN fourni contre celui généré à la création de la Delivery.
   *
   * **Cascade Order — dépend du paiement** :
   *   - `paied === true`  (ONLINE ou espèce encaissée d'avance)
   *       → Order `COMPLETED` + `completed_at = now` — la commande est finie.
   *   - `paied === false` (OFFLINE pas encore encaissée)
   *       → Order reste en `COLLECTED` + `collected_at = now` seulement.
   *       La commande apparaîtra dans la colonne « Collectées » du backoffice
   *       jusqu'à ce que la caissière appelle `markPaidCash` (livreur rentre
   *       au restaurant et verse l'argent → `COMPLETED` à ce moment-là).
   *       Si le livreur tarde trop à encaisser, le regroupement côté
   *       backoffice (`group-orders.ts`) la bascule en « Problèmes » au
   *       dépassement du seuil `OVERDUE_COLLECTED_UNPAID_MIN`.
   */
  async confirmDelivery(deliveryId: string, delivererId: string, dto: ConfirmDeliveryDto) {
    // Rejeu avec le bon code (réponse perdue, double toucher) : la livraison
    // est rendue telle quelle. Avant, le 400 qui suivait poussait le livreur
    // vers « Problème » sur une commande déjà remise.
    const deja = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { statut: true, delivery_pin: true, course: { select: { deliverer_id: true } } },
    });
    if (deja?.statut === DeliveryStatut.DELIVERED && deja.course.deliverer_id === delivererId && deja.delivery_pin === dto.pin) {
      return this.lireSansCode(deliveryId);
    }

    const delivery = await this.assertOwned(deliveryId, delivererId, DeliveryStatut.ARRIVED);

    if (delivery.delivery_pin !== dto.pin) {
      throw new BadRequestException('PIN invalide');
    }

    const now = new Date();
    const isPaid = delivery.order.paied;
    const orderUpdate = isPaid
      ? {
          status: OrderStatus.COMPLETED,
          collected_at: now,
          completed_at: now,
        }
      : {
          status: OrderStatus.COLLECTED,
          collected_at: now,
        };

    // Écritures CONDITIONNÉES sur l'état lu : un « Problème » validé au même
    // instant n'est jamais effacé par la confirmation (ni l'inverse).
    const ecrite = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          statut: DeliveryStatut.ARRIVED,
          course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
        },
        data: { statut: DeliveryStatut.DELIVERED, delivered_at: now },
      });
      if (count !== 1) return false;
      await tx.order.updateMany({
        where: { id: delivery.order_id, status: { notIn: COMMANDES_CLOSES } },
        data: orderUpdate,
      });
      return true;
    });
    if (!ecrite) return this.livraisonChangee(deliveryId, DeliveryStatut.DELIVERED);
    const updated = await this.lireSansCode(deliveryId);

    // ENCAISSEMENT À LA LIVRAISON : commande non payée → le livreur a choisi le
    // moyen de paiement du client dans l'app. On enregistre un Paiement
    // EN ATTENTE — le backoffice le confirme (bouton), ce qui marque la
    // commande payée et la termine. Même mécanique que la flotte Turbo :
    // codes fermés, défaut espèces, un seul PENDING par commande (index
    // unique partiel — le doublon concurrent tombe en P2002 = no-op).
    if (!isPaid) {
      await this.enregistrerEncaissementLivreur(delivery.order, dto).catch((e) =>
        this.logger.error(
          `Encaissement livreur non enregistré pour ${delivery.order.reference}: ${(e as Error)?.message}`,
        ),
      );
    }

    await this.emitDeliveryStatut(updated, delivery.statut);
    await this.checkCourseCompletion(delivery.course_id);
    return updated;
  }

  /** Enregistre l'encaissement déclaré par le livreur INTERNE (Paiement PENDING + cloche). */
  private async enregistrerEncaissementLivreur(
    order: {
      id: string;
      reference: string;
      amount: number;
      restaurant_id: string;
      customer_id: string;
    },
    dto: ConfirmDeliveryDto,
  ): Promise<void> {
    const dejaDeclare = await this.prisma.paiement.findFirst({
      where: { order_id: order.id, status: PaiementStatus.PENDING },
      select: { id: true },
    });
    if (dejaDeclare) return;

    // PAIEMENT PARTAGÉ : liste `encaissements` (une ligne par moyen, agrégée),
    // sinon champ simple, sinon espèces pour le montant total.
    const lignes = normaliserEncaissements(
      {
        encaissements: dto.encaissements,
        moyenPaiement: dto.moyen_paiement,
        montantEncaisse: dto.montant_encaisse,
      },
      order.amount,
    );

    try {
      const horodatage = Date.now();
      await this.prisma.$transaction(
        lignes.map((ligne, i) =>
          this.prisma.paiement.create({
            data: {
              reference: `LIVREUR-${order.reference}-${horodatage}-${i}`,
              amount: ligne.montant,
              total: ligne.montant,
              fees: 0,
              mode: ligne.mode,
              source: ligne.source,
              status: PaiementStatus.PENDING,
              order_id: order.id,
              client_id: order.customer_id,
            },
          }),
        ),
      );
    } catch (err: any) {
      // Index unique (1 PENDING par commande ET par moyen) : un lot concurrent
      // a déjà gagné — la transaction du perdant est annulée en bloc.
      if (err?.code === 'P2002') return;
      throw err;
    }

    const detail = libelleEncaissements(lignes);
    const total = lignes.reduce((somme, l) => somme + l.montant, 0);

    this.logger.log(
      `Encaissement livreur interne enregistré (EN ATTENTE) — commande ${order.reference} : ${detail}.`,
    );

    this.notificationsSender
      .sendTurboPaymentPendingBell({
        reference: order.reference,
        restaurantId: order.restaurant_id,
        montant: total,
        moyenLabel:
          lignes.length > 1
            ? lignes.map((l) => `${l.label} (${l.montant.toLocaleString('fr-FR')} XOF)`).join(' + ')
            : lignes[0].label,
        livreurLabel: 'le livreur Chicken Nation',
      })
      .catch(() => undefined);
  }

  /**
   * « ANNULER » de la feuille « Problème » (demande du 27/10) : le livreur
   * annule la LIVRAISON de ce client (absent, refus, adresse introuvable…),
   * JAMAIS la commande. Une seule méthode pour la nouvelle route `/annuler`
   * et pour `/fail`, celle de l'appli déjà installée (`origine`).
   *
   * Avant le 27/10, `/fail` annulait aussi la commande (« cancelled_by
   * deliverer »). Règle du client : une commande ne s'annule qu'à la main, par
   * l'administration (remboursement ou bon, points et coupons rendus).
   *
   * Refus, dans l'ordre (mêmes messages qu'avant) :
   *  1. rejeu : sa livraison déjà en échec est rendue telle quelle (réponse
   *     perdue, double toucher), sans événement, ticket ni journal ;
   *  2. livraison inconnue (404), d'un autre livreur (403) ;
   *  3. course pas en livraison, livraison pas à faire (400) ;
   *  4. « Autre » sans note (400) ;
   *  5. commande pas encore remise au livreur (409 « Commande pas encore
   *     remise. »). Une commande déjà annulée par l'admin pendant la tournée
   *     passe : le livreur doit pouvoir clore, la commande n'est pas réécrite.
   *
   * Écriture CONDITIONNÉE d'un seul tenant (livraison à faire, livreur de la
   * course, course en livraison, commande remise) : la livraison seule passe
   * en échec, avec son motif et sa note. AUCUNE écriture sur la commande : elle
   * reste en livraison (le sac est chez le livreur), avec son heure de retrait
   * et son drapeau « payée ». Aucun paiement écrit ; points et coupons ne sont
   * rendus que pour une commande annulée (leurs relais ne bougent pas). Le
   * planificateur ne la reprend jamais seul (elle a sa livraison), « Relancer
   * la livraison » d'une course annulée non plus (livraison en échec, pas
   * annulée). Le siège la rend au même livreur (« Relancer la livraison » de
   * la commande, 28/10) ou la caisse reçoit le sac (« Sac rapporté »).
   *
   * Ensuite, seulement si l'écriture a eu lieu : `course:delivery:statut:changed`,
   * fin de la course s'il ne reste rien à livrer (livreur remis dans la file),
   * ligne LIVRAISON_ANNULEE au journal, et l'événement interne qui fait créer
   * le ticket du livreur par le module support. Ni le journal ni le ticket ne
   * font échouer le geste.
   */
  async annulerLivraison(
    deliveryId: string,
    delivererId: string,
    dto: FailDeliveryDto,
    origine: OrigineAnnulationLivraison,
  ) {
    const deja = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { statut: true, course: { select: { deliverer_id: true } } },
    });
    if (deja?.statut === DeliveryStatut.FAILED && deja.course.deliverer_id === delivererId) {
      return this.lireSansCode(deliveryId);
    }

    const delivery = await this.assertOwned(deliveryId, delivererId, LIVRAISON_A_FAIRE);

    // OTHER nécessite une note
    if (dto.reason === DeliveryFailureReason.OTHER && !dto.note?.trim()) {
      throw new BadRequestException('Une note est requise pour le motif OTHER');
    }

    if (COMMANDE_PAS_REMISE.includes(delivery.order.status)) {
      throw new ConflictException(MESSAGE_DEPART_AVANT_RETRAIT);
    }

    const now = new Date();
    const issue = await this.prisma.$transaction(async (tx) => {
      const echouee = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          statut: { in: LIVRAISON_A_FAIRE },
          course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
          order: { status: { notIn: COMMANDE_PAS_REMISE } },
        },
        data: {
          statut: DeliveryStatut.FAILED,
          failed_at: now,
          failure_reason: dto.reason,
          failure_note: dto.note,
        },
      });
      if (echouee.count === 1) return 'ecrite' as const;
      // Changée depuis la lecture (remise, confiée à un autre, course close,
      // commande rendue au comptoir) : rien n'est écrit, le refus dit pourquoi.
      const relue = await tx.delivery.findUnique({
        where: { id: deliveryId },
        select: {
          statut: true,
          course: { select: { deliverer_id: true, statut: true } },
          order: { select: { status: true } },
        },
      });
      // Son « Annuler » passé au même instant (double toucher) : rendue telle quelle.
      if (relue?.statut === DeliveryStatut.FAILED && relue.course.deliverer_id === delivererId) return 'deja' as const;
      const refus = refusLivraison(relue, delivererId, LIVRAISON_A_FAIRE);
      if (refus) throw refus;
      if (relue && COMMANDE_PAS_REMISE.includes(relue.order.status)) {
        throw new ConflictException(MESSAGE_DEPART_AVANT_RETRAIT);
      }
      throw new BadRequestException(messageStatutAttendu(LIVRAISON_A_FAIRE, relue!.statut));
    });
    const updated = await this.lireSansCode(deliveryId);
    if (issue === 'deja') return updated;

    await this.emitDeliveryStatut(updated, delivery.statut);
    await this.checkCourseCompletion(delivery.course_id);
    await this.annoncerLivraisonAnnulee(
      {
        delivery_id: deliveryId,
        order_id: delivery.order_id,
        order_reference: delivery.order.reference,
        course_id: delivery.course_id,
        course_reference: delivery.course.reference,
        restaurant_id: delivery.course.restaurant_id,
        deliverer_id: delivererId,
        reason: dto.reason,
        note: dto.note?.trim() || null,
        route: origine,
      },
    );
    return updated;
  }

  /**
   * `/fail` de l'appli déjà installée : même service que « Annuler » (27/10),
   * la livraison seule passe en échec, la commande n'est plus jamais annulée.
   */
  async failDelivery(deliveryId: string, delivererId: string, dto: FailDeliveryDto) {
    return this.annulerLivraison(deliveryId, delivererId, dto, 'fail');
  }

  /** Après une livraison annulée par le livreur : journal, puis le ticket (module support). Jamais d'erreur. */
  private async annoncerLivraisonAnnulee(p: LivraisonAnnuleeParLivreurPayload): Promise<void> {
    // Le journal avale ses propres erreurs.
    await this.journal?.ecrire({
      type: 'LIVRAISON_ANNULEE',
      motif: p.reason,
      source: 'appli',
      restaurant_id: p.restaurant_id,
      course_id: p.course_id,
      deliverer_id: p.deliverer_id,
      order_id: p.order_id,
      details: { route: p.route, note: p.note },
    });
    try {
      this.courseEvent.livraisonAnnuleeParLivreur(p);
    } catch (err) {
      this.logger.error(
        `Livraison ${p.order_reference} annulée, ticket non demandé : ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Notation du client par le livreur après une livraison.
   *
   * Règles :
   *  - La livraison doit appartenir au livreur.
   *  - Le statut doit être terminal (DELIVERED ou FAILED) — on ne note pas
   *    une livraison encore en cours.
   *  - Une seule note par livraison (idempotent côté UI : si déjà notée,
   *    on retourne 400 pour que le client masque le bouton).
   */
  async rateCustomer(deliveryId: string, delivererId: string, dto: RateCustomerDto) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { course: { select: { deliverer_id: true } } },
    });
    if (!delivery) throw new NotFoundException('Delivery non trouvée');
    if (delivery.course.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cette livraison ne vous est pas affectée");
    }

    const TERMINAL_FOR_RATING: DeliveryStatut[] = [
      DeliveryStatut.DELIVERED,
      DeliveryStatut.FAILED,
    ];
    if (!TERMINAL_FOR_RATING.includes(delivery.statut)) {
      throw new BadRequestException(
        'La livraison doit être terminée (DELIVERED ou FAILED) pour pouvoir être notée',
      );
    }

    if (delivery.customer_rating !== null) {
      throw new BadRequestException('Cette livraison a déjà été notée');
    }

    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      // Le livreur ne doit JAMAIS lire le code : c'est le client qui le lui
      // dicte, et c'est ce qui prouve la remise. Sans cette omission, la
      // reponse de la route lui donnait de quoi valider sans voir personne.
      omit: { delivery_pin: true },
      data: {
        customer_rating: dto.rating,
        customer_rating_note: dto.note ?? null,
        customer_rated_at: new Date(),
      },
    });

    this.logger.log(
      `Delivery ${deliveryId} notée ${dto.rating}/5 par livreur ${delivererId}`,
    );
    return updated;
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  /**
   * Vérifie ownership + statut attendu. Inclut l'order (champs paid / payment_method)
   * pour que `confirmDelivery` puisse décider si la commande passe `COMPLETED`
   * ou reste `COLLECTED` en attendant l'encaissement caissière.
   */
  private async assertOwned(deliveryId: string, delivererId: string, expected: DeliveryStatut | DeliveryStatut[]) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        course: true,
        order: {
          select: {
            id: true,
            paied: true,
            payment_method: true,
            // Encaissement à la livraison (commande non payée)
            reference: true,
            // Commande ajoutée après le retrait : pas encore remise tant qu'elle est prête.
            status: true,
            amount: true,
            restaurant_id: true,
            customer_id: true,
          },
        },
      },
    });
    const refus = refusLivraison(delivery, delivererId, Array.isArray(expected) ? expected : [expected]);
    if (refus) throw refus;
    return delivery!;
  }

  /**
   * L'écriture conditionnée n'a rien trouvé : la livraison a changé entre la
   * lecture et l'écriture. Déjà dans l'état visé (double toucher) : rendue
   * telle quelle, sans événement ; sinon 400, rien n'est écrit.
   */
  private async livraisonChangee(deliveryId: string, visee: DeliveryStatut) {
    const relue = await this.lireSansCode(deliveryId);
    if (relue.statut === visee) return relue;
    throw new BadRequestException(`Statut delivery changé entre-temps, actuel ${relue.statut}`);
  }

  /**
   * Vérifie si toutes les Delivery de la Course sont terminées (DELIVERED/FAILED/CANCELLED).
   * Si oui → Course passe en COMPLETED + émet event.
   *
   * Aussi appelée quand une commande restée au comptoir après le départ passe
   * à emporter et que plus rien d'autre n'est à livrer
   * (`DetachementCommandeService`) : la course se termine comme après sa
   * dernière livraison.
   *
   * Course verrouillée AVANT la lecture qui décide (28/10) : « Relancer la
   * livraison » du siège remet une livraison annulée dans cette course en
   * tenant sa ligne jusqu'à la fin de sa transaction. Lue sans ce verrou, la
   * fin de course voyait encore l'échec, attendait la ligne, puis terminait la
   * course avec la livraison relancée dedans : plus personne pour la livrer.
   * Sous le verrou, la lecture voit la livraison relancée et la course
   * continue. Même verrou que le démarrage d'une livraison et « Plus tard ».
   */
  async checkCourseCompletion(courseId: string) {
    // Tri sans verrou : il reste un client, sa propre fin refera ce passage.
    const lues = await this.prisma.delivery.findMany({
      where: { course_id: courseId },
      select: { statut: true },
    });
    if (!toutesTerminees(lues)) return;

    // Réservation : deux fins de livraison au même instant ne terminent la
    // course (événement, remise en file, notification) qu'une fois.
    const deliveries = await this.prisma.$transaction(async (tx) => {
      const maintenant = new Date();
      const tenue = await tx.course.updateMany({
        where: { id: courseId, statut: CourseStatut.IN_DELIVERY },
        data: { updated_at: maintenant },
      });
      if (tenue.count !== 1) return null;
      // Relue sous le verrou : une relance validée entre-temps est vue ici.
      const relues = await tx.delivery.findMany({
        where: { course_id: courseId },
        select: { statut: true },
      });
      if (!toutesTerminees(relues)) return null;
      const { count } = await tx.course.updateMany({
        where: { id: courseId, statut: CourseStatut.IN_DELIVERY },
        data: { statut: CourseStatut.COMPLETED, completed_at: maintenant },
      });
      return count === 1 ? relues : null;
    });
    if (!deliveries) return;
    const completed = await this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      include: COURSE_FULL_INCLUDE,
    });

    const success_count = deliveries.filter((d) => d.statut === DeliveryStatut.DELIVERED).length;
    const fail_count = deliveries.length - success_count;

    // P5 : remettre le livreur en queue FIFO (si pas en pause).
    if (completed.deliverer_id) {
      await this.queueService.onComplete(completed.deliverer_id);
    }

    await this.courseEvent.courseCompleted({ course: completed, success_count, fail_count });

    // P-push livreur : confirmation visuelle + sonore de la fin de course.
    if (completed.deliverer_id) {
      this.pushService.notifyCourseCompleted({
        delivererId: completed.deliverer_id,
        courseReference: completed.reference,
        courseId: completed.id,
      });
    }

    this.logger.log(
      `Course ${completed.reference} COMPLETED (${success_count} livrée(s), ${fail_count} échec(s))`,
    );
  }

  private async emitDeliveryStatut(delivery: any, previous: DeliveryStatut) {
    const course = await this.prisma.course.findUnique({
      where: { id: delivery.course_id },
      select: { reference: true, restaurant_id: true },
    });
    await this.courseEvent.deliveryStatutChanged({
      delivery,
      course_id: delivery.course_id,
      course_reference: course?.reference ?? '',
      restaurant_id: course?.restaurant_id ?? null,
      previous_statut: previous,
      new_statut: delivery.statut,
    });
  }
}
