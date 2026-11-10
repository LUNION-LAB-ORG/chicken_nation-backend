import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  DeliveryService,
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
import { DeliverersService } from 'src/modules/deliverers/services/deliverers.service';
import { ComptePersonnel } from 'src/modules/users/helpers/personnel-scope.helper';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { CourseEvent } from '../events/course.event';
import {
  messageAffectation,
  MESSAGE_COMMANDE_AUTRE_RESTAURANT,
  MESSAGE_LIVREUR_AUTRE_RESTAURANT_EN_COURSE,
  peutAgirSurCommande,
  RAISON_COMMANDE_AFFECTEE,
  refusCommandeAAffecter,
  refusLivreurAffectation,
} from '../helpers/affectation-commande.rules';
import { RaisonsPlanificateur, texteCommandeAjoutee } from '../helpers/application-plan.rules';
import { CLASSE_VERROU_OFFRE_LIVREUR } from '../helpers/offres.rules';
import { CourseHelper } from '../helpers/course.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { recalculerFraisCourse } from '../helpers/frais-course';
import { STATUTS_COURSE_DU_LIVREUR } from '../helpers/relance-livraison.rules';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { MESSAGE_COMMANDE_CHANGEE, MESSAGE_COMMANDE_INTROUVABLE } from '../helpers/sac-rapporte.rules';
import { CourseActionService } from './course-action.service';
import { DetachementCommandeService, DetachementPrevu } from './detachement-commande.service';
import { OffresClotureService } from './offres-cloture.service';

const SELECTION_COMMANDE = {
  id: true,
  reference: true,
  status: true,
  type: true,
  entity_status: true,
  restaurant_id: true,
  delivery: { select: { statut: true, course: { select: { deliverer_id: true } } } },
} satisfies Prisma.OrderSelect;

type CommandeLue = Prisma.OrderGetPayload<{ select: typeof SELECTION_COMMANDE }>;

/** Réponse de `POST /courses/commandes/:orderId/affecter`. */
export interface ReponseAffectation {
  order_id: string;
  reference: string;
  course_id: string;
  course_reference: string;
  /** Course créée pour elle (le livreur n'en avait aucune). */
  nouvelle_course: boolean;
  /** Socket ouvert ; `false` : par notification seulement ; `null` : inconnu. */
  appli_connectee: boolean | null;
  message: string;
}

interface AffectationEcrite {
  course_id: string;
  nouvelle: boolean;
  journal: Record<string, unknown>;
}

/**
 * « AFFECTER À UN LIVREUR » : règles dans `affectation-commande.rules.ts`.
 *
 * Contrairement à « Forcer l'affectation » d'une course, qui lui envoie une
 * offre, la commande lui est donnée d'office : un livreur en course ne peut pas
 * répondre à une offre. Tout est écrit d'un seul tenant, sous le verrou des
 * offres du livreur : la commande quitte sa course et rejoint celle du livreur.
 * Si l'écriture échoue après l'annulation chez Turbo, la course est relancée
 * (`DetachementCommandeService.apresEcriture`).
 */
@Injectable()
export class AffectationCommandeService {
  private readonly logger = new Logger('Dispatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly helper: CourseHelper,
    private readonly courseEvent: CourseEvent,
    private readonly push: DelivererPushService,
    private readonly appliLivreur: AppliLivreurService,
    private readonly cloture: OffresClotureService,
    private readonly gateway: AppGateway,
    private readonly actions: CourseActionService,
    private readonly detachement: DetachementCommandeService,
    // Renfort (10/11) : un livreur d'un autre restaurant détecté près de celui de la commande.
    @Optional() private readonly livreurs?: DeliverersService,
  ) {}

  /**
   * Garde des gestes sur une commande à livrer (affecter, retirer, liste des
   * livreurs proposés) : rend le restaurant de la commande si ce compte peut y
   * agir (`peutAgirSurCommande`). 404 inconnue ou supprimée, 403 commande d'un
   * autre restaurant pour le manager et l'assistant manager (09/11).
   */
  async restaurantPourGeste(orderId: string, compte: ComptePersonnel | undefined): Promise<string> {
    const commande = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { restaurant_id: true, entity_status: true },
    });
    if (!commande || commande.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException(MESSAGE_COMMANDE_INTROUVABLE);
    }
    if (!peutAgirSurCommande(compte, commande.restaurant_id)) {
      throw new ForbiddenException(MESSAGE_COMMANDE_AUTRE_RESTAURANT);
    }
    return commande.restaurant_id;
  }

  async affecter(
    orderId: string,
    delivererId: string,
    user: ComptePersonnel | undefined,
    maintenant = new Date(),
  ): Promise<ReponseAffectation> {
    const commande = await this.prisma.order.findUnique({ where: { id: orderId }, select: SELECTION_COMMANDE });
    if (!commande || commande.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException(MESSAGE_COMMANDE_INTROUVABLE);
    }
    const refus = refusCommandeAAffecter(commande, delivererId);
    if (refus) throw new ConflictException(refus);

    const { appli, renfort } = await this.verifierLivreur(delivererId, commande.restaurant_id, maintenant);
    // Refus clair avant tout geste : sac remis, livreur Turbo déjà engagé.
    const retrait = await this.detachement.examinerRetrait(orderId, maintenant);
    // Offre en attente chez ce livreur : close sans pénalité, sa recherche repart.
    await this.cloture.clorePourLivreur(delivererId, 'LIVREUR_INDISPONIBLE', {
      source: 'admin',
      details: { raison: RAISON_COMMANDE_AFFECTEE },
    });
    if (retrait) await this.detachement.annulerChezTurbo(retrait);

    let ecrite: AffectationEcrite;
    try {
      ecrite = await this.ecrire(commande, delivererId, appli, renfort, retrait, user, maintenant);
    } catch (err) {
      if (retrait) await this.detachement.apresEcriture(retrait, { ecrit: false });
      throw err;
    }
    if (retrait) await this.detachement.apresEcriture(retrait, { ecrit: true, maintenant });
    return this.annoncer(commande, delivererId, ecrite);
  }

  /**
   * Le livreur existe et peut recevoir la commande ; rend le contexte de son
   * appli, relu sous le verrou, et s'il vient d'un autre restaurant en renfort.
   */
  private async verifierLivreur(
    delivererId: string,
    restaurantId: string,
    maintenant: Date,
  ): Promise<{ appli: ContexteAppli; renfort: boolean }> {
    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { ...SELECT_ETAT_LIVREUR, expo_push_token: true },
    });
    if (!ligne) throw new NotFoundException('Livreur non trouvé');
    const appli = await this.appliLivreur.contexte([ligne], maintenant);
    const renfort = ligne.restaurant_id !== restaurantId && (await this.permisEnRenfort(delivererId, restaurantId, maintenant));
    const refus = refusLivreurAffectation(
      { ...etatLivreurDepuis(ligne, appli, maintenant), restaurant_id: ligne.restaurant_id },
      ligne._count.courses > 0,
      restaurantId,
      maintenant,
      renfort,
    );
    if (refus) throw new ConflictException(refus);
    return { appli: appli ?? SANS_REGLE_APPLI, renfort };
  }

  /**
   * Livreur d'un autre restaurant (demande du 10/11) : déjà en course pour
   * celui de la commande (elle rejoint sa course), ou libre et détecté près
   * de lui, par la règle du planificateur (`DeliverersService.renfortsPour`).
   */
  private async permisEnRenfort(delivererId: string, restaurantId: string, maintenant: Date): Promise<boolean> {
    const ici = await this.prisma.course.findFirst({
      where: {
        deliverer_id: delivererId,
        restaurant_id: restaurantId,
        statut: { in: STATUTS_COURSE_DU_LIVREUR },
        turbo_escalated_at: null,
      },
      select: { id: true },
    });
    if (ici) return true;
    if (!this.livreurs) return false;
    return (await this.livreurs.renfortsPour(restaurantId, maintenant, [delivererId])).has(delivererId);
  }

  /**
   * L'écriture d'un seul tenant. Ordre des verrous comme au comptoir et au
   * planificateur : les courses, puis la commande. Retry sur collision de
   * référence (P2002), comme à la création d'une course.
   */
  private async ecrire(
    commande: CommandeLue,
    delivererId: string,
    appli: ContexteAppli,
    renfort: boolean,
    retrait: DetachementPrevu | null,
    user: ComptePersonnel | undefined,
    maintenant: Date,
  ): Promise<AffectationEcrite> {
    for (let essai = 0; essai < 3; essai++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLASSE_VERROU_OFFRE_LIVREUR}::int, hashtext(${delivererId}))`;

          // Offre née entre la clôture et le verrou : rien n'est écrit.
          const offre = await tx.courseOfferAttempt.findFirst({
            where: { deliverer_id: delivererId, status: CourseOfferStatus.PENDING },
            select: { id: true },
          });
          if (offre) {
            throw new ConflictException(
              messageRefusOffre('OFFRE_EN_ATTENTE', { pause_until: null, auto_pause_until: null }, maintenant),
            );
          }

          // Le livreur et ses courses, relus sous le verrou.
          const ligne = await tx.deliverer.findUnique({ where: { id: delivererId }, select: SELECT_ETAT_LIVREUR });
          const courses = await tx.course.findMany({
            where: { deliverer_id: delivererId, statut: { in: STATUTS_COURSE_DU_LIVREUR }, turbo_escalated_at: null },
            orderBy: { assigned_at: 'desc' },
            select: { id: true, statut: true, restaurant_id: true, reference: true },
          });
          // Renfort : vu libre et proche avant le verrou, ou en course ici sous le verrou.
          const enRenfort = renfort || courses.some((c) => c.restaurant_id === commande.restaurant_id);
          const refus = refusLivreurAffectation(
            ligne && { ...etatLivreurDepuis(ligne, appli, maintenant), restaurant_id: ligne.restaurant_id },
            courses.length > 0,
            commande.restaurant_id,
            maintenant,
            enRenfort,
          );
          if (refus) throw new ConflictException(refus);
          const existante = courses.find((c) => c.restaurant_id === commande.restaurant_id) ?? null;
          if (!existante && courses.length > 0) {
            throw new ConflictException(MESSAGE_LIVREUR_AUTRE_RESTAURANT_EN_COURSE);
          }
          if (existante) {
            // Ligne de la course verrouillée : sa fin ne passe pas devant cette livraison.
            const tenue = await tx.course.updateMany({
              where: { id: existante.id, deliverer_id: delivererId, statut: { in: STATUTS_COURSE_DU_LIVREUR } },
              data: { updated_at: maintenant },
            });
            if (tenue.count !== 1) throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);
          }

          // La commande quitte sa course. Une livraison déjà terminée d'une
          // course morte s'efface : une commande n'a qu'une livraison.
          if (retrait) await this.detachement.retirerDansTransaction(tx, retrait, maintenant);
          await tx.delivery.deleteMany({
            where: { order_id: commande.id, statut: { in: [DeliveryStatut.CANCELLED, DeliveryStatut.FAILED] } },
          });

          // Revendication : toujours prête, sans course. Elle sort de Turbo.
          const aRattacher: Prisma.OrderWhereInput = {
            id: commande.id,
            type: OrderType.DELIVERY,
            status: OrderStatus.READY,
            delivery: null,
            entity_status: { not: EntityStatus.DELETED },
          };
          const tenue = await tx.order.updateMany({
            where: aRattacher,
            data: { delivery_service: DeliveryService.CHICKEN_NATION },
          });
          if (tenue.count !== 1) throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);
          const lue = await tx.order.findUniqueOrThrow({
            where: { id: commande.id },
            select: { recovery_code: true },
          });

          let cible: { id: string; reference: string };
          if (existante) {
            cible = existante;
          } else {
            cible = await tx.course.create({
              data: {
                reference: this.helper.generateReference(),
                pickup_code: await this.helper.genererCodeRetrait(tx, commande.restaurant_id, maintenant),
                restaurant_id: commande.restaurant_id,
                statut: CourseStatut.ACCEPTED,
                deliverer_id: delivererId,
                assigned_at: maintenant,
                total_delivery_fee: 0,
              },
              select: { id: true, reference: true },
            });
            // Hors de la file, comme à l'acceptation d'une offre ; sans pénalité.
            await tx.deliverer.updateMany({ where: { id: delivererId }, data: { last_available_at: null } });
          }

          const max = await tx.delivery.aggregate({ where: { course_id: cible.id }, _max: { sequence_order: true } });
          await tx.delivery.create({
            data: {
              course_id: cible.id,
              order_id: commande.id,
              sequence_order: (max._max.sequence_order ?? 0) + 1,
              // Le code du client vient de la commande : il l'a déjà sous les yeux.
              delivery_pin: lue.recovery_code ?? this.helper.generateDeliveryPin(),
              statut: DeliveryStatut.PENDING,
              ...(existante ? { ajoutee_at: maintenant } : {}),
              // Jamais retirée à son départ : c'est un choix du siège, un sac
              // resté au comptoir lui est signalé comme un sac oublié.
              ajoutee_apres_retrait: false,
            },
          });
          await recalculerFraisCourse(tx, cible.id);

          const journal = {
            type: 'COMMANDE_AFFECTEE',
            motif: existante ? 'LIVREUR_EN_COURSE' : 'NOUVELLE_COURSE',
            source: 'admin',
            restaurant_id: commande.restaurant_id,
            course_id: cible.id,
            deliverer_id: delivererId,
            order_id: commande.id,
            details: {
              commande: commande.reference,
              course_apres: cible.reference,
              course_avant: retrait?.course_reference ?? null,
              chez_turbo_avant: retrait?.cas === 'TURBO',
              // Livreur d'un autre restaurant (10/11).
              ...(ligne && ligne.restaurant_id !== commande.restaurant_id ? { renfort: true } : {}),
              par: { id: user?.id ?? null, role: user?.role ?? null },
            },
          };
          await tx.dispatchEvenement.create({ data: journal });
          return { course_id: cible.id, nouvelle: !existante, journal };
        });
      } catch (err) {
        const e = err as { code?: string; meta?: { target?: unknown } };
        if (e?.code === 'P2002') {
          if (String(e.meta?.target ?? '').includes('reference')) continue;
          throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);
        }
        throw err;
      }
    }
    throw new HttpException('Génération reference impossible', 500);
  }

  /** Après l'écriture : écrans et livreur. Ne lève pas pour une annonce manquée (le geste est enregistré). */
  private async annoncer(
    commande: CommandeLue,
    delivererId: string,
    ecrite: AffectationEcrite,
  ): Promise<ReponseAffectation> {
    this.logger.log(JSON.stringify(ecrite.journal));

    // Commande antérieure au code client : le code tiré est recopié sur la commande.
    const pin = await this.prisma.delivery.findFirst({
      where: { order_id: commande.id, order: { recovery_code: null } },
      select: { delivery_pin: true },
    });
    if (pin?.delivery_pin) {
      await this.prisma.order
        .update({ where: { id: commande.id }, data: { recovery_code: pin.delivery_pin } })
        .catch((e) => this.logger.error(`Report du code sur la commande ${commande.id} échoué : ${e?.message}`));
    }

    const course = await this.prisma.course.findUniqueOrThrow({
      where: { id: ecrite.course_id },
      include: COURSE_FULL_INCLUDE,
    });
    try {
      if (ecrite.nouvelle) {
        await this.courseEvent.courseAssigned({ course });
        this.push.notifyCourseAssigned({
          delivererId,
          courseReference: course.reference,
          restaurantName: course.restaurant?.name ?? 'le restaurant',
          courseId: course.id,
        });
      } else {
        await this.courseEvent.courseStatutChanged({
          course,
          previous_statut: course.statut,
          new_statut: course.statut,
          reason: RaisonsPlanificateur.COMMANDE_AJOUTEE,
        });
        const total = course.deliveries.filter((d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut)).length;
        const apresRetrait = course.statut === CourseStatut.IN_DELIVERY;
        const texte = texteCommandeAjoutee({ ajoutees: 1, total, apresRetrait, code: course.pickup_code });
        this.push.notifyCommandeAjoutee({
          delivererId,
          courseId: course.id,
          courseReference: course.reference,
          titre: texte.titre,
          corps: texte.corps,
          ajoutees: 1,
          total,
          apresRetrait,
          code: course.pickup_code,
        });
        void this.actions.estimerDureeTournee(course.id).catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`Commande ${commande.reference} affectée : annonce en échec (${(err as Error)?.message ?? err})`);
    }

    const appliConnectee = await this.gateway.livreurConnecte(delivererId).catch(() => null);
    return {
      order_id: commande.id,
      reference: commande.reference,
      course_id: course.id,
      course_reference: course.reference,
      nouvelle_course: ecrite.nouvelle,
      appli_connectee: appliConnectee,
      message: messageAffectation({
        reference: commande.reference,
        prenom: course.deliverer?.first_name ?? null,
        nouvelle: ecrite.nouvelle,
        statutCourse: course.statut,
        appliConnectee,
      }),
    };
  }
}
