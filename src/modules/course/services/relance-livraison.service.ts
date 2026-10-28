import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  Delivery,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  OrderType,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import {
  ContexteAppli,
  SANS_REGLE_APPLI,
  SELECT_ETAT_LIVREUR,
  etatLivreurDepuis,
  messageRefusOffre,
} from 'src/modules/deliverers/helpers/disponibilite.rules';
import { AppliLivreurService } from 'src/modules/deliverers/services/appli-livreur.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { ComptePersonnel } from 'src/modules/users/helpers/personnel-scope.helper';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { CourseEvent } from '../events/course.event';
import { CourseHelper } from '../helpers/course.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { recalculerFraisCourse } from '../helpers/frais-course';
import { CLASSE_VERROU_OFFRE_LIVREUR } from '../helpers/offres.rules';
import {
  aDemarrerApresRelance,
  detailsRelance,
  estLivraisonARelancer,
  MOTIF_DEPART_RELANCE,
  peutEtreRejeuRelance,
  RAISON_LIVRAISON_RELANCEE,
  rangsApresRelance,
  refusLivreurRelance,
  refusSansRelance,
  relanceeEnDernier,
  STATUTS_COURSE_DU_LIVREUR,
} from '../helpers/relance-livraison.rules';
import { MESSAGE_COMMANDE_ANNULEE, MESSAGE_COMMANDE_CHANGEE, MESSAGE_COMMANDE_INTROUVABLE } from '../helpers/sac-rapporte.rules';
import type { CourseWithDetails } from '../interfaces/course-event.interface';
import { CourseWebSocketService } from '../websockets/course-websocket.service';
import { CourseActionService } from './course-action.service';
import type { TypeEvenementDispatch } from './dispatch-journal.service';
import { OffresClotureService } from './offres-cloture.service';

/** Ce que le geste lit de la commande : sa livraison, sa course, son livreur. Jamais le code du client. */
const SELECTION_RELANCE = {
  id: true,
  reference: true,
  status: true,
  type: true,
  entity_status: true,
  restaurant_id: true,
  picked_up_at: true,
  delivery: {
    select: {
      id: true,
      statut: true,
      course_id: true,
      sequence_order: true,
      in_route_at: true,
      arrived_at: true,
      failed_at: true,
      failure_reason: true,
      failure_note: true,
      reportee_at: true,
      customer_rating: true,
      customer_rating_note: true,
      course: {
        select: {
          id: true,
          reference: true,
          statut: true,
          restaurant_id: true,
          turbo_escalated_at: true,
          deliverer: { select: { id: true, first_name: true } },
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

type CommandeRelance = Prisma.OrderGetPayload<{ select: typeof SELECTION_RELANCE }>;

/** La course qui reçoit la livraison, relue sous le verrou. */
const SELECTION_CIBLE = {
  id: true,
  reference: true,
  restaurant_id: true,
  parti_at: true,
  deliveries: {
    select: {
      id: true,
      statut: true,
      sequence_order: true,
      ajoutee_apres_retrait: true,
      order: { select: { status: true } },
    },
  },
} satisfies Prisma.CourseSelect;

/** Réponse de `POST /courses/commandes/:orderId/relancer-livraison`. */
export interface ReponseRelanceLivraison {
  order_id: string;
  reference: string;
  course_id: string;
  course_reference: string;
  /** Course créée pour elle (le livreur n'avait aucune course). */
  nouvelle_course: boolean;
  /** Place dans la tournée (1 à N). */
  rang: number;
  /** Livraison mise « en route » tout de suite. */
  demarree: boolean;
  livreur: { id: string; prenom: string | null };
  /** Socket ouvert ; `false` : par notification seulement ; `null` : inconnu. */
  appli_connectee: boolean | null;
  /** Rejeu (double toucher) : rien n'est réécrit ni émis. */
  deja: boolean;
}

/** Ce que l'écriture a fait, pour les annonces et la réponse. */
interface RelanceEcrite {
  order_id: string;
  reference: string;
  delivery_id: string;
  livreur: { id: string; prenom: string | null };
  ancienne: { id: string };
  cible: { id: string; reference: string; restaurant_id: string };
  nouvelle_course: boolean;
  rang: number;
  demarree: boolean;
  en_dernier: boolean;
  journal: Record<string, unknown>;
}

/** La commande, la livraison ou la course a changé pendant l'écriture : tout est annulé, la commande est relue. */
class RelanceChangee extends Error {}

const TYPE_JOURNAL: TypeEvenementDispatch = 'LIVRAISON_RELANCEE';

/**
 * « RELANCER LA LIVRAISON » d'une livraison annulée par le livreur (demande
 * du 28/10). Règles : `relance-livraison.rules.ts`.
 *
 * Le livreur a touché « Annuler » (livraison en échec, commande toujours en
 * livraison, sac chez lui) ; le siège a trouvé une solution avec le client.
 * La MÊME ligne de livraison (même code du client) est remise au MÊME livreur,
 * sans offre ni passage au restaurant, en UNE transaction sous le verrou des
 * offres du livreur :
 *  - il a une course en livraison (partie ou encore au comptoir) : elle en
 *    rejoint la fin, et ne démarre que si plus rien d'autre n'est à livrer ;
 *  - il n'a aucune course : une course neuve est créée pour lui, directement
 *    en livraison et partie (`LIVRAISON_DEMARREE`), livraison démarrée ;
 *  - il va au restaurant pour une autre course : refus (« Sac rapporté » à
 *    son arrivée).
 * La commande n'est jamais touchée (claim sur la même valeur) : paiements,
 * encaissement à la livraison, points, coupons, ticket et Turbo ne bougent
 * pas. Ligne LIVRAISON_RELANCEE au journal, dans la transaction.
 *
 * Ensuite seulement : changement de la livraison à tous (backoffice,
 * restaurant, livreur, client, planificateur), courses relues au siège et au
 * restaurant, socket et notification « Livraison relancée » au livreur.
 * L'alerte « a annulé » et le rappel du sac tombent seuls (plus d'échec).
 */
@Injectable()
export class RelanceLivraisonService {
  private readonly logger = new Logger('Dispatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly helper: CourseHelper,
    private readonly courseEvent: CourseEvent,
    private readonly ws: CourseWebSocketService,
    private readonly push: DelivererPushService,
    private readonly appliLivreur: AppliLivreurService,
    private readonly cloture: OffresClotureService,
    private readonly gateway: AppGateway,
    // Durée de la tournée (fin prévue, retard) quand la livraison rejoint une course existante.
    private readonly actions: CourseActionService,
  ) {}

  async relancer(
    orderId: string,
    user: ComptePersonnel | undefined,
    maintenant = new Date(),
  ): Promise<ReponseRelanceLivraison> {
    // Deux essais au plus : un claim perdu (double toucher, « Sac rapporté »
    // ou annulation au même instant) relit la commande et refait les gardes.
    for (let essai = 0; essai < 2; essai++) {
      const lue = await this.lireAvecGardes(orderId);
      if (!estLivraisonARelancer(lue)) return this.sansRelance(lue);
      const livreur = lue.delivery!.course.deliverer!;

      const appli = await this.verifierLivreur(livreur.id, maintenant);
      // Offre en attente chez ce livreur : close sans pénalité, l'appli la
      // ferme et la recherche repart pour sa course.
      await this.cloture.clorePourLivreur(livreur.id, 'LIVREUR_INDISPONIBLE', {
        source: 'admin',
        details: { raison: RAISON_LIVRAISON_RELANCEE },
      });

      const ecrite = await this.ecrire(lue, appli, user, maintenant);
      if (ecrite) {
        await this.annoncer(ecrite);
        return {
          order_id: ecrite.order_id,
          reference: ecrite.reference,
          course_id: ecrite.cible.id,
          course_reference: ecrite.cible.reference,
          nouvelle_course: ecrite.nouvelle_course,
          rang: ecrite.rang,
          demarree: ecrite.demarree,
          livreur: ecrite.livreur,
          appli_connectee: await this.appliConnectee(livreur.id),
          deja: false,
        };
      }
    }
    const lue = await this.lireAvecGardes(orderId);
    if (!estLivraisonARelancer(lue)) return this.sansRelance(lue);
    throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);
  }

  /** Gardes 1 et 2 : commande inconnue ou supprimée (404), annulée (409). */
  private async lireAvecGardes(orderId: string): Promise<CommandeRelance> {
    const lue = await this.prisma.order.findUnique({ where: { id: orderId }, select: SELECTION_RELANCE });
    if (!lue || lue.entity_status === EntityStatus.DELETED) throw new NotFoundException(MESSAGE_COMMANDE_INTROUVABLE);
    if (lue.status === OrderStatus.CANCELLED) throw new ConflictException(MESSAGE_COMMANDE_ANNULEE);
    return lue;
  }

  /**
   * Plus de livraison annulée à relancer. Rejeu : la livraison est de nouveau
   * active chez ce livreur et la dernière décision du journal est sa relance
   * (aucune annulation depuis) : 200 `deja`, rien n'est réécrit ni émis.
   * Sinon 409 avec la raison.
   */
  private async sansRelance(lue: CommandeRelance): Promise<ReponseRelanceLivraison> {
    if (peutEtreRejeuRelance(lue)) {
      const l = lue.delivery!;
      const livreur = l.course.deliverer!;
      const relance = await this.prisma.dispatchEvenement.findFirst({
        where: { type: TYPE_JOURNAL, order_id: lue.id },
        orderBy: { created_at: 'desc' },
        select: { created_at: true, deliverer_id: true, details: true },
      });
      if (relance && relance.deliverer_id === livreur.id) {
        const annuleeDepuis = await this.prisma.dispatchEvenement.findFirst({
          where: { type: 'LIVRAISON_ANNULEE', order_id: lue.id, created_at: { gt: relance.created_at } },
          select: { id: true },
        });
        if (!annuleeDepuis) {
          const details = (relance.details ?? {}) as Record<string, unknown>;
          return {
            order_id: lue.id,
            reference: lue.reference,
            course_id: l.course.id,
            course_reference: l.course.reference,
            nouvelle_course: details.nouvelle_course === true,
            rang: l.sequence_order,
            demarree: details.demarree === true,
            livreur: { id: livreur.id, prenom: livreur.first_name ?? null },
            appli_connectee: await this.appliConnectee(livreur.id),
            deja: true,
          };
        }
      }
    }
    const peutAvoirSac = lue.status === OrderStatus.READY || lue.status === OrderStatus.IN_PROGRESS;
    const sac = peutAvoirSac
      ? await this.prisma.dispatchEvenement.findFirst({
          where: { type: 'SAC_RAPPORTE', order_id: lue.id },
          select: { id: true },
        })
      : null;
    throw refusSansRelance(lue.status, !!sac);
  }

  /**
   * Garde 4 : le livreur peut-il reprendre la livraison ? (lu comme
   * l'affectation forcée : état, jeton, appli). 409 avec la raison.
   *
   * @returns le contexte de son appli, relu sous le verrou par l'écriture.
   */
  private async verifierLivreur(livreurId: string, maintenant: Date): Promise<ContexteAppli> {
    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: livreurId },
      select: { ...SELECT_ETAT_LIVREUR, expo_push_token: true },
    });
    const appli = ligne ? await this.appliLivreur.contexte([ligne], maintenant) : SANS_REGLE_APPLI;
    const courses = await this.prisma.course.findMany({
      where: { deliverer_id: livreurId, statut: { in: STATUTS_COURSE_DU_LIVREUR } },
      select: { statut: true },
    });
    const refus = refusLivreurRelance(
      ligne && { ...etatLivreurDepuis(ligne, appli, maintenant), restaurant_id: ligne.restaurant_id },
      courses,
      maintenant,
    );
    if (refus) throw new ConflictException(refus.message);
    return appli;
  }

  /**
   * L'écriture d'un seul tenant ; `null` si un claim est perdu (rien n'est
   * écrit, course neuve comprise). Retry sur collision de référence (P2002),
   * comme à la création d'une course.
   */
  private async ecrire(
    lue: CommandeRelance,
    appli: ContexteAppli,
    user: ComptePersonnel | undefined,
    maintenant: Date,
  ): Promise<RelanceEcrite | null> {
    const livraison = lue.delivery!;
    const ancienne = livraison.course;
    const livreur = { id: ancienne.deliverer!.id, prenom: ancienne.deliverer!.first_name ?? null };

    for (let essai = 0; essai < 3; essai++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // 1. Verrou des offres du livreur : deux relances pour lui passent
          //    l'une après l'autre (la seconde rejoint la course de la
          //    première), et aucune offre ne lui naît pendant ce temps.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLASSE_VERROU_OFFRE_LIVREUR}::int, hashtext(${livreur.id}))`;

          // 2. Offre née entre la clôture et le verrou : rien n'est écrit.
          const offre = await tx.courseOfferAttempt.findFirst({
            where: { deliverer_id: livreur.id, status: CourseOfferStatus.PENDING },
            select: { id: true },
          });
          if (offre) {
            throw new ConflictException(
              messageRefusOffre('OFFRE_EN_ATTENTE', { pause_until: null, auto_pause_until: null }, maintenant),
            );
          }

          // 3. Commande tenue, même valeur réécrite : « Sac rapporté » ou
          //    l'annulation au même instant attendent la fin, ou l'ont emporté.
          const tenue = await tx.order.updateMany({
            where: {
              id: lue.id,
              status: OrderStatus.PICKED_UP,
              type: OrderType.DELIVERY,
              entity_status: { not: EntityStatus.DELETED },
            },
            data: { status: OrderStatus.PICKED_UP },
          });
          if (tenue.count !== 1) throw new RelanceChangee();

          // 4. Le livreur relu sous le verrou, puis la course qui reçoit la livraison.
          const ligne = await tx.deliverer.findUnique({ where: { id: livreur.id }, select: SELECT_ETAT_LIVREUR });
          const courses = await tx.course.findMany({
            where: { deliverer_id: livreur.id, statut: { in: STATUTS_COURSE_DU_LIVREUR } },
            orderBy: { assigned_at: 'desc' },
            select: { id: true, statut: true, turbo_escalated_at: true },
          });
          const refus = refusLivreurRelance(
            ligne && { ...etatLivreurDepuis(ligne, appli, maintenant), restaurant_id: ligne.restaurant_id },
            courses,
            maintenant,
          );
          if (refus) throw new ConflictException(refus.message);

          const enLivraison =
            courses.find((c) => c.statut === CourseStatut.IN_DELIVERY && c.turbo_escalated_at === null) ?? null;
          let nouvelle = false;
          let cibleId: string;
          if (enLivraison) {
            // Ligne de la course verrouillée (comme le démarrage d'une
            // livraison et « Plus tard ») : jamais deux livraisons en route,
            // et la fin de course, qui prend ce verrou avant de relire les
            // livraisons, voit la relancée (`checkCourseCompletion`).
            const verrou = await tx.course.updateMany({
              where: { id: enLivraison.id, deliverer_id: livreur.id, statut: CourseStatut.IN_DELIVERY },
              data: { updated_at: maintenant },
            });
            if (verrou.count !== 1) throw new RelanceChangee();
            cibleId = enLivraison.id;
          } else {
            const creee = await tx.course.create({
              data: {
                reference: this.helper.generateReference(),
                pickup_code: await this.helper.genererCodeRetrait(tx, ancienne.restaurant_id, maintenant),
                restaurant_id: ancienne.restaurant_id,
                statut: CourseStatut.IN_DELIVERY,
                deliverer_id: livreur.id,
                assigned_at: maintenant,
                // Le vrai retrait : la commande n'a jamais quitté le livreur.
                picked_up_at: lue.picked_up_at ?? maintenant,
                parti_at: maintenant,
                motif_depart: MOTIF_DEPART_RELANCE,
                estimated_duration_min: null,
                total_delivery_fee: 0,
              },
              select: { id: true },
            });
            // Hors de la file, comme à l'acceptation d'une offre ; sans pénalité.
            await tx.deliverer.updateMany({ where: { id: livreur.id }, data: { last_available_at: null } });
            cibleId = creee.id;
            nouvelle = true;
          }
          const cible = await tx.course.findUniqueOrThrow({ where: { id: cibleId }, select: SELECTION_CIBLE });

          // 5. La livraison : même ligne, même code, remise à zéro de l'échec.
          const autres = cible.deliveries.filter((l) => l.id !== livraison.id);
          const demarree = aDemarrerApresRelance({ nouvelle, parti_at: cible.parti_at, autres });
          const deplacee = cible.id !== ancienne.id;
          // Rang provisoire libre, pris dans la lecture sous le verrou : celui
          // lu avant la transaction a pu être donné à une autre livraison
          // (« Plus tard » renumérote la tournée), d'où la contrainte unique
          // course + rang. La renumérotation qui suit remet les rangs de 1 à N.
          const rangProvisoire = Math.max(0, ...cible.deliveries.map((l) => l.sequence_order)) + 1;
          const reprise = await tx.delivery.updateMany({
            where: {
              id: livraison.id,
              order_id: lue.id,
              statut: DeliveryStatut.FAILED,
              course_id: ancienne.id,
              course: { deliverer_id: livreur.id, turbo_escalated_at: null },
            },
            data: {
              course_id: cible.id,
              sequence_order: rangProvisoire,
              statut: demarree ? DeliveryStatut.IN_ROUTE : DeliveryStatut.PENDING,
              in_route_at: demarree ? maintenant : null,
              failed_at: null,
              failure_reason: null,
              failure_note: null,
              arrived_at: null,
              reportee_at: null,
              customer_rating: null,
              customer_rating_note: null,
              customer_rated_at: null,
              ...(deplacee && !nouvelle ? { ajoutee_at: maintenant } : {}),
            },
          });
          if (reprise.count !== 1) throw new RelanceChangee();

          // 6. Rangs de 1 à N, en deux temps (contrainte unique course + rang).
          const lignes = [...autres, { id: livraison.id, statut: DeliveryStatut.PENDING, sequence_order: rangProvisoire }];
          const rangs = rangsApresRelance(lignes, livraison.id);
          const decalage = Math.max(0, ...lignes.map((l) => l.sequence_order)) + lignes.length;
          await tx.delivery.updateMany({ where: { course_id: cible.id }, data: { sequence_order: { increment: decalage } } });
          for (const [id, rang] of rangs) {
            await tx.delivery.updateMany({ where: { id, course_id: cible.id }, data: { sequence_order: rang } });
          }
          const rang = rangs.get(livraison.id)!;

          // 8. Journal dans la transaction : la copie de ce que la relance efface.
          const journal = {
            type: TYPE_JOURNAL,
            motif: livraison.failure_reason ?? null,
            source: 'admin',
            restaurant_id: lue.restaurant_id,
            course_id: ancienne.id,
            deliverer_id: livreur.id,
            order_id: lue.id,
            details: detailsRelance({
              commande: lue.reference,
              course_avant: ancienne.reference,
              course_apres: cible.reference,
              nouvelle_course: nouvelle,
              rang,
              demarree,
              livraison,
              par: { id: user?.id ?? null, role: user?.role ?? null },
            }),
          };
          await tx.dispatchEvenement.create({ data: { ...journal, details: journal.details as Prisma.InputJsonValue } });

          // 9. Frais : l'ancienne course perd l'arrêt (statut inchangé), la cible le gagne.
          if (deplacee) await recalculerFraisCourse(tx, ancienne.id);
          await recalculerFraisCourse(tx, cible.id);

          return {
            order_id: lue.id,
            reference: lue.reference,
            delivery_id: livraison.id,
            livreur,
            ancienne: { id: ancienne.id },
            cible: { id: cible.id, reference: cible.reference, restaurant_id: cible.restaurant_id },
            nouvelle_course: nouvelle,
            rang,
            demarree,
            en_dernier: relanceeEnDernier(demarree, autres),
            journal,
          };
        });
      } catch (err) {
        if (err instanceof RelanceChangee) return null;
        const e = err as { code?: string; meta?: { target?: unknown } };
        if (e?.code === 'P2002' && String(e.meta?.target ?? '').includes('reference')) continue;
        throw err;
      }
    }
    throw new HttpException('Génération reference impossible', 500);
  }

  /** Après l'écriture : écrans, client, livreur. Ne lève jamais (le geste est enregistré). */
  private async annoncer(e: RelanceEcrite): Promise<void> {
    this.logger.log(JSON.stringify(e.journal));

    // 1. La livraison (sans le code du client) : backoffice, restaurant,
    //    livreur (sa course relue), client (code, carte, heure d'arrivée,
    //    WhatsApp de départ), planificateur.
    try {
      const lue = await this.prisma.delivery.findUnique({ where: { id: e.delivery_id }, omit: { delivery_pin: true } });
      if (lue) {
        const { delivery_pin: _code, ...livraison } = lue as Delivery;
        await this.courseEvent.deliveryStatutChanged({
          delivery: livraison as Delivery,
          course_id: e.cible.id,
          course_reference: e.cible.reference,
          restaurant_id: e.cible.restaurant_id,
          previous_statut: DeliveryStatut.FAILED,
          new_statut: lue.statut,
        });
      }
    } catch (err) {
      this.logger.warn(`Livraison relancée ${e.reference} : changement non annoncé (${(err as Error)?.message ?? err})`);
    }

    // 2. La course cible, et l'ancienne si elle a perdu l'arrêt : siège et restaurant.
    for (const courseId of e.cible.id === e.ancienne.id ? [e.cible.id] : [e.cible.id, e.ancienne.id]) {
      try {
        const course = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
        if (course) {
          this.ws.emitSuiviOffre({
            course: course as unknown as CourseWithDetails,
            previous_statut: course.statut,
            new_statut: course.statut,
            reason: RAISON_LIVRAISON_RELANCEE,
          });
        }
      } catch (err) {
        this.logger.warn(`Livraison relancée ${e.reference} : course non relue (${(err as Error)?.message ?? err})`);
      }
    }

    // 3. Le livreur : socket et notification (il repart vers le client).
    try {
      this.ws.emitLivraisonRelancee(e.livreur.id, {
        order_id: e.order_id,
        delivery_id: e.delivery_id,
        reference: e.reference,
        course_id: e.cible.id,
        nouvelle_course: e.nouvelle_course,
        rang: e.rang,
        demarree: e.demarree,
      });
    } catch (err) {
      this.logger.warn(`Livraison relancée ${e.reference} : livreur non prévenu (${(err as Error)?.message ?? err})`);
    }
    this.push.notifyLivraisonRelancee({
      delivererId: e.livreur.id,
      courseId: e.cible.id,
      orderId: e.order_id,
      deliveryId: e.delivery_id,
      reference: e.reference,
      enDernier: e.en_dernier,
    });

    // 4. Tournée existante : fin prévue et retard recalculés. Course neuve :
    //    rien (l'heure d'arrivée du client vient de la position du livreur).
    if (!e.nouvelle_course) void this.actions.estimerDureeTournee(e.cible.id).catch(() => undefined);
  }

  /** Socket du livreur ouvert ; `null` si la présence n'a pas pu être lue. */
  private async appliConnectee(livreurId: string): Promise<boolean | null> {
    try {
      return await this.gateway.livreurConnecte(livreurId);
    } catch {
      return null;
    }
  }
}
