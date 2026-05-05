import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';

/**
 * Types de push notifications envoyés au livreur.
 * Doit rester aligné avec le routing tap-handler côté mobile :
 * `chicken-nation-deli/lib/push-notifications/use-push-notifications.ts`
 */
export type DelivererPushType =
  | 'new_course_offer' // Nouvelle offre de course (CRITIQUE)
  | 'course_assigned' // Confirmation d'acceptation
  | 'course_pickup_validated' // Caissière a validé → tu peux partir
  | 'course_completed' // Course terminée
  | 'course_cancelled' // Course annulée
  | 'auto_paused' // Auto-pause déclenchée
  | 'account_activated' // Admin a validé ton compte
  | 'plan_sent' // Nouveau planning à valider
  | 'presence_check' // Check-in matinal 8h
  | 'new_ticket_message'; // Réponse support (déjà géré dans TicketMessageService)

interface NotifyInput {
  delivererId: string;
  type: DelivererPushType;
  title: string;
  body: string;
  /** Données arbitraires utilisées pour le routing au tap (ex: courseId, ticketId). */
  data?: Record<string, unknown>;
  /** `true` pour les notifs critiques (offre course, auto-pause) — son fort + priorité haute. */
  critical?: boolean;
  /**
   * Catégorie de notif (iOS/Android) — déclenche les boutons d'action
   * pré-enregistrés côté mobile via `setNotificationCategoryAsync`.
   * Ex: `'new_course_offer'` → boutons Accepter/Refuser sur le lockscreen.
   */
  categoryId?: string;
}

/**
 * Service centralisé d'envoi de push notifications au livreur (P-push livreur).
 *
 * Responsabilités :
 *   1. Récupérer le `expo_push_token` du livreur (skip silencieux si absent)
 *   2. Construire le payload Expo Push avec le bon channel + son + priorité
 *   3. Déléguer l'envoi à `ExpoPushService`
 *
 * Toutes les méthodes sont fire-and-forget : un échec d'envoi ne doit JAMAIS
 * bloquer la mutation principale (acceptation course, validation, etc.).
 * Les erreurs sont loguées mais propagées en silence (le livreur recevra
 * l'event WS de toute façon, la push est un bonus).
 */
@Injectable()
export class DelivererPushService {
  private readonly logger = new Logger(DelivererPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPush: ExpoPushService,
  ) {}

  /**
   * Envoie une push notif au livreur. Skip silencieux si pas de token.
   * Fire-and-forget — ne JAMAIS await dans une mutation critique.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const deliverer = await this.prisma.deliverer.findUnique({
        where: { id: input.delivererId },
        select: { expo_push_token: true, first_name: true },
      });

      if (!deliverer?.expo_push_token) {
        this.logger.debug(
          `[Push] skip ${input.type} → livreur ${input.delivererId.slice(0, 8)} sans token`,
        );
        return;
      }

      await this.expoPush.sendPushNotifications({
        tokens: [deliverer.expo_push_token],
        title: input.title,
        body: input.body.substring(0, 200),
        sound: 'default',
        priority: input.critical ? 'high' : 'normal',
        channelId: 'default',
        categoryId: input.categoryId,
        data: {
          type: input.type,
          ...input.data,
        },
      });

      this.logger.log(
        `[Push] ${input.type} → ${deliverer.first_name ?? input.delivererId.slice(0, 8)} : "${input.title}"`,
      );
    } catch (err) {
      this.logger.warn(
        `[Push] échec ${input.type} pour ${input.delivererId.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Wrapper fire-and-forget : on lance la promesse sans await pour ne pas
   * ralentir le caller. Utilise `notify()` directement si tu veux await.
   */
  fireAndForget(input: NotifyInput): void {
    this.notify(input).catch(() => {
      // Logged déjà dans notify() — ne rien faire ici.
    });
  }

  // ============================================================
  // RACCOURCIS MÉTIER (un par type, signature minimale)
  // ============================================================

  notifyNewCourseOffer(input: {
    delivererId: string;
    courseReference: string;
    restaurantName: string;
    courseId: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'new_course_offer',
      title: 'Nouvelle course !',
      body: `Une commande de ${input.restaurantName} t'attend`,
      data: { courseId: input.courseId, reference: input.courseReference },
      critical: true,
      // Catégorie qui déclenche les boutons "Accepter" / "Refuser" sur le
      // lockscreen — gros gain UX pour le livreur (un tap au lieu de
      // déverrouiller + ouvrir l'app + scroller).
      categoryId: 'new_course_offer',
    });
  }

  notifyCourseAssigned(input: {
    delivererId: string;
    courseReference: string;
    restaurantName: string;
    courseId: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'course_assigned',
      title: 'Course confirmée',
      body: `${input.courseReference} en route vers ${input.restaurantName}`,
      data: { courseId: input.courseId },
    });
  }

  notifyPickupValidated(input: {
    delivererId: string;
    courseReference: string;
    courseId: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'course_pickup_validated',
      title: 'Colis prêts',
      body: `La caissière a validé ${input.courseReference} — tu peux partir`,
      data: { courseId: input.courseId },
    });
  }

  notifyCourseCompleted(input: {
    delivererId: string;
    courseReference: string;
    courseId: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'course_completed',
      title: 'Course terminée',
      body: `${input.courseReference} terminée — bravo !`,
      data: { courseId: input.courseId },
    });
  }

  notifyCourseCancelled(input: {
    delivererId: string;
    courseReference: string;
    cancelledBy: string;
    courseId: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'course_cancelled',
      title: 'Course annulée',
      body: `${input.courseReference} annulée par ${input.cancelledBy}`,
      data: { courseId: input.courseId },
      critical: true,
    });
  }

  notifyAutoPaused(input: {
    delivererId: string;
    refusalCount: number;
    windowMinutes: number;
    durationMinutes: number;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'auto_paused',
      title: 'Auto-pause activée',
      body: `${input.refusalCount} refus en ${input.windowMinutes} min — pause ${input.durationMinutes} min`,
      data: {},
      critical: true,
    });
  }

  notifyAccountActivated(input: { delivererId: string; restaurantName?: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'account_activated',
      title: 'Compte validé !',
      body: input.restaurantName
        ? `Tu peux commencer à recevoir des courses pour ${input.restaurantName}`
        : 'Tu peux commencer à recevoir des courses',
      data: {},
      critical: true,
    });
  }

  notifyPlanSent(input: {
    delivererId: string;
    periodStart: string;
    periodEnd: string;
    planId: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'plan_sent',
      title: 'Nouveau planning',
      body: `Plan ${input.periodStart} → ${input.periodEnd} à valider`,
      data: { planId: input.planId },
    });
  }

  notifyPresenceCheck(input: { delivererId: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'presence_check',
      title: 'Check-in matinal',
      body: "Tu es opérationnel aujourd'hui ?",
      data: {},
    });
  }
}
