import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';

/**
 * Types de push notifications envoyés au staff (caissière/manager/cuisine).
 * Doit rester aligné avec le routing tap-handler côté mobile
 * (`chicken-nation-pro-app/lib/push-notifications/`).
 */
export type StaffPushType =
  | 'new_order' // 🔔 Nouvelle commande pour le restaurant (CRITIQUE)
  | 'order_status_changed' // Le livreur a collecté / livré
  | 'order_problem'; // Anomalie sur une commande (retard, etc.)

interface NotifyRestaurantInput {
  restaurantId: string;
  type: StaffPushType;
  title: string;
  body: string;
  /** Données arbitraires utilisées pour le routing au tap (ex: orderId). */
  data?: Record<string, unknown>;
  /** `true` pour les notifs critiques (nouvelle commande) — son fort + priorité haute. */
  critical?: boolean;
  /**
   * Restreint les destinataires à certains rôles (ex: cuisine seulement pour
   * la préparation). Par défaut : tous les staffs du restaurant.
   */
  roles?: string[];
}

/**
 * Service centralisé d'envoi de push notifications au staff.
 *
 *  1. Récupère les `expo_push_token` des Users `type=RESTAURANT` du restaurant
 *     (skip silencieux si liste vide)
 *  2. Construit le payload Expo Push avec le bon channel + son + priorité
 *  3. Déléguer l'envoi à `ExpoPushService`
 *
 * Fire-and-forget : un échec d'envoi ne doit JAMAIS bloquer la mutation
 * principale (création commande, etc.). Les erreurs sont loguées mais
 * propagées en silence — la socket reste la source primaire de l'update.
 */
@Injectable()
export class UserPushService {
  private readonly logger = new Logger(UserPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPush: ExpoPushService,
  ) {}

  /**
   * Notifie tous les staffs RESTAURANT d'un restaurant donné.
   * Skip silencieux si aucun staff n'a de token (jamais loggé sur mobile).
   */
  async notifyRestaurant(input: NotifyRestaurantInput): Promise<void> {
    try {
      const users = await this.prisma.user.findMany({
        where: {
          restaurant_id: input.restaurantId,
          type: 'RESTAURANT',
          entity_status: 'ACTIVE',
          expo_push_token: { not: null },
          ...(input.roles?.length
            ? { role: { in: input.roles as never[] } }
            : {}),
        },
        select: { id: true, expo_push_token: true },
      });

      const tokens = users
        .map((u) => u.expo_push_token)
        .filter((t): t is string => !!t);

      if (tokens.length === 0) {
        this.logger.debug(
          `[Push staff] skip ${input.type} → resto ${input.restaurantId.slice(0, 8)} : aucun token`,
        );
        return;
      }

      await this.expoPush.sendPushNotifications({
        tokens,
        title: input.title,
        body: input.body.substring(0, 200),
        sound: 'default',
        priority: input.critical ? 'high' : 'normal',
        channelId: 'default',
        data: {
          type: input.type,
          ...input.data,
        },
      });

      this.logger.log(
        `[Push staff] ${input.type} → ${tokens.length} staffs (resto ${input.restaurantId.slice(0, 8)}) : "${input.title}"`,
      );
    } catch (err) {
      this.logger.error(
        `[Push staff] erreur envoi ${input.type} : ${(err as Error).message}`,
      );
    }
  }

  /**
   * Enregistre / met à jour le token Expo Push d'un utilisateur staff.
   * Appelé par `POST /users/me/expo-push-token` depuis l'app mobile.
   */
  async registerToken(userId: string, token: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { expo_push_token: token },
    });
  }
}
