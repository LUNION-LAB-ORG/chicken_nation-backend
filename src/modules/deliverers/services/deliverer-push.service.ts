import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { JournalLimite, suffixeTues } from 'src/common/utils/journal-limite.util';

/**
 * Types de push notifications envoyés au livreur.
 * Doit rester aligné avec le routing tap-handler côté mobile :
 * `chicken-nation-deli/lib/push-notifications/use-push-notifications.ts`
 */
export type DelivererPushType =
  | 'new_course_offer' // Nouvelle offre de course (CRITIQUE)
  | 'course_assigned' // Confirmation d'acceptation
  | 'course_pickup_validated' // Caissière a validé → tu peux partir
  | 'commande_ajoutee' // Planificateur : commande(s) ajoutée(s) à ta course (avant ou après le retrait)
  | 'commande_retiree' // Planificateur : commande ajoutée pas remise, retirée à ton départ
  | 'course_attente' // Planificateur : départ retenu, attends une commande encore en cuisine
  | 'course_tout_pret' // Planificateur : plus rien à attendre, présente ton code
  | 'commande_remise' // Commande ajoutée remise avec le même code : tu peux partir
  | 'sac_oublie' // Parti du restaurant alors qu'un sac de la course y est encore noté
  | 'course_completed' // Course terminée
  | 'course_cancelled' // Course annulée
  | 'auto_paused' // Auto-pause déclenchée
  | 'pause_rappel' // L'appli demande « disponible » pendant une pause : rien ne change
  | 'mis_en_pause' // Offre ignorée sans aucun signal : mis hors service par le serveur
  | 'account_activated' // Admin a validé ton compte
  | 'account_rejected' // Admin a refusé la candidature
  | 'account_suspended' // Admin a suspendu le compte
  | 'account_reactivated' // Admin a réactivé le compte suspendu
  | 'plan_sent' // Nouveau planning à valider
  | 'plan_modifie' // Planning envoyé ou confirmé changé par le restaurant (repos, retrait, dates, annulation)
  | 'presence_check' // Question de présence du matin (8 h)
  | 'new_ticket_message' // Réponse support
  | 'appel_entrant'; // Le service client appelle le livreur dans l'appli (24/10)

/** Canal des offres : sonnerie dédiée (Android : canal ; iOS : son embarqué). */
export const CANAL_OFFRES = 'offres_v1';
/**
 * Canal des appels du service client (relecture du 24/10) : sonnerie longue,
 * vibration répétée, importance maximale. Créé par l'appli 1.1.0, qui embarque
 * `sonnerie_appel.wav` ; une appli plus ancienne la reçoit sur le canal de
 * secours d'Android, avec le son du système. Sur le canal par défaut, l'appel
 * ne faisait qu'un « ding » court, comme un message.
 */
export const CANAL_APPELS = 'appels_v1';
/** Son de l'appel du service client (iOS : fichier embarqué dans le binaire 1.1.0). */
export const SON_APPEL = 'sonnerie_appel.wav';
/**
 * Appli qui rend muettes, appli ouverte, les notifications des événements de
 * course (TYPES_MUETS_APPLI_OUVERTE) et sait les faire vibrer elle-même.
 */
export const PROTOCOLE_APPLI_SIMPLE = 3;

/**
 * Canal et son d'une notification selon l'appli du livreur. L'ancienne appli
 * joue le son de TOUTE notification reçue au premier plan : sur le canal des
 * offres, la validation du retrait, une annulation ou un ajout sonnaient
 * comme une nouvelle course alors qu'aucune offre ne s'affichait. Pour elle,
 * seule l'offre (`new_course_offer`) garde la sonnerie des offres ; le reste
 * repasse au son du système, comme avant.
 */
export function canalPourAppli(
  input: Pick<NotifyInput, 'type' | 'channelId' | 'sound'>,
  protocoleAppli: number | null | undefined,
): { channelId: string; sound: string } {
  const channelId = input.channelId ?? 'default';
  const sound = input.sound ?? 'default';
  const ancienneAppli = (protocoleAppli ?? 0) < PROTOCOLE_APPLI_SIMPLE;
  if (ancienneAppli && channelId === CANAL_OFFRES && input.type !== 'new_course_offer') {
    return { channelId: 'default', sound: 'default' };
  }
  return { channelId, sound };
}

/** « 14 h 32 » : heure d'Abidjan (UTC toute l'année), comme les autres textes du livreur. */
export function heureCourteAbidjan(date: Date): string {
  return `${date.getUTCHours()} h ${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export interface NotifyInput {
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
  /**
   * Canal Android. Le SON et la VIBRATION sont portés par le canal côté mobile :
   * `offres_v1` déclenche la sonnerie dédiée aux offres de course.
   * Par défaut `default` (son système).
   */
  channelId?: string;
  /**
   * Son iOS (Android l'ignore, c'est le canal qui décide). Nom du fichier
   * embarqué dans le binaire, extension comprise, ex. `offre_course.wav`.
   */
  sound?: string;
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
  private readonly sansJetonLimite = new JournalLimite(10 * 60_000);

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
        select: { expo_push_token: true, first_name: true, protocole_appli: true },
      });

      if (!deliverer?.expo_push_token) {
        // Offre sans notification possible : si son appli n'est pas connectée en
        // temps réel, le livreur ne la verra pas du tout. Visible en production,
        // une ligne par livreur toutes les 10 min au plus.
        const tues =
          input.type === 'new_course_offer'
            ? this.sansJetonLimite.autoriser(input.delivererId)
            : null;
        if (tues !== null) {
          this.logger.warn(
            `[Push] ${input.type} → livreur ${input.delivererId.slice(0, 8)} sans jeton de notification : ` +
              `rien envoyé${suffixeTues(tues)}`,
          );
        } else {
          this.logger.debug(
            `[Push] skip ${input.type} → livreur ${input.delivererId.slice(0, 8)} sans token`,
          );
        }
        return;
      }

      const canal = canalPourAppli(input, deliverer.protocole_appli);
      await this.expoPush.sendPushNotifications({
        tokens: [deliverer.expo_push_token],
        title: input.title,
        body: input.body.substring(0, 200),
        sound: canal.sound,
        priority: input.critical ? 'high' : 'normal',
        channelId: canal.channelId,
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
      // Sonnerie dédiée : le bip système d'une seconde passait inaperçu pour un
      // livreur au volant ou casque sur les oreilles.
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /**
   * RELANCE d'une offre non traitée, pendant la fenêtre d'acceptation.
   *
   * Une seule notification laisse au livreur UNE chance de voir l'offre : s'il
   * est distrait à cet instant (téléphone en poche, moteur allumé, casque), la
   * course lui échappe alors qu'il était disponible. On le re-sollicite donc à
   * mi-parcours avec le temps restant, ce qui crée l'urgence sans harceler.
   */
  notifyCourseOfferReminder(input: {
    delivererId: string;
    courseReference: string;
    restaurantName: string;
    courseId: string;
    secondsLeft: number;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'new_course_offer',
      // Livreurs qui lisent peu : un chiffre et deux mots (demande du 23/10).
      title: `Offre : ${input.secondsLeft} s`,
      body: 'Réponds vite',
      data: { courseId: input.courseId, reference: input.courseReference },
      critical: true,
      // Mêmes boutons Accepter/Refuser sur l'écran verrouillé, et même sonnerie
      // que l'offre initiale : c'est la relance qui doit percer la distraction.
      categoryId: 'new_course_offer',
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
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
      title: 'Sacs remis',
      body: 'Tu peux partir',
      data: { courseId: input.courseId },
      // Canal qui sonne et vibre : le livreur doit sentir la remise, appli en
      // arrière-plan comprise (demande du 23/10).
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  // ── Planificateur v2 : ce qui change dans la course du livreur ─────────
  // Livreurs souvent peu à l'aise avec l'écrit : titres et corps de 1 à 4
  // mots, des chiffres (commandes, code, heure, minutes), tutoiement. Même
  // canal que les offres (`offres_v1`, sonnerie et vibration) : chaque
  // événement doit se sentir, appli en arrière-plan comprise. Un type inconnu
  // de l'ancienne appli ouvre l'accueil : sans risque.

  /**
   * Commande(s) ajoutée(s) à la course. `data` : `courseId`, `reference`,
   * `ajoutees`, `total`, `apresRetrait`, `code` (code de retrait, même code).
   */
  notifyCommandeAjoutee(input: {
    delivererId: string;
    courseId: string;
    courseReference: string;
    titre: string;
    corps: string;
    ajoutees: number;
    total: number;
    apresRetrait: boolean;
    code: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'commande_ajoutee',
      title: input.titre,
      body: input.corps,
      data: {
        courseId: input.courseId,
        reference: input.courseReference,
        ajoutees: input.ajoutees,
        total: input.total,
        apresRetrait: input.apresRetrait,
        code: input.code,
      },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /** Commande ajoutée après le retrait, pas remise : retirée au départ. `data.restantes`. */
  notifyCommandeRetiree(input: {
    delivererId: string;
    courseId: string;
    titre: string;
    corps: string;
    commande: string;
    restantes: number;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'commande_retiree',
      title: input.titre,
      body: input.corps,
      data: { courseId: input.courseId, commande: input.commande, restantes: input.restantes },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /**
   * Parti du restaurant alors qu'une commande de la course d'origine y est
   * encore notée « prête » (remise commande par commande à la caisse) : le
   * livreur le sait tout de suite, en même temps que la cloche du restaurant
   * et du siège. `data.commandes` (références), `data.sacs` (nombre).
   */
  notifySacOublie(input: { delivererId: string; courseId: string; titre: string; corps: string; commandes: string[] }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'sac_oublie',
      title: input.titre,
      body: input.corps,
      data: { courseId: input.courseId, commandes: input.commandes, sacs: input.commandes.length },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /** Départ retenu au comptoir. `data.jusqua` (ISO), `data.attendues` (références). */
  notifyCourseAttente(input: {
    delivererId: string;
    courseId: string;
    titre: string;
    corps: string;
    jusqua: Date;
    attendues: string[];
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'course_attente',
      title: input.titre,
      body: input.corps,
      data: { courseId: input.courseId, jusqua: input.jusqua.toISOString(), attendues: input.attendues },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /** Plus rien à attendre : présente ton code. `data.code`. */
  notifyCourseToutPret(input: { delivererId: string; courseId: string; titre: string; corps: string; code: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'course_tout_pret',
      title: input.titre,
      body: input.corps,
      data: { courseId: input.courseId, code: input.code },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /** Commande ajoutée remise avec le même code : tu peux partir. */
  notifyCommandeRemise(input: { delivererId: string; courseId: string; titre: string; corps: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'commande_remise',
      title: input.titre,
      body: input.corps,
      data: { courseId: input.courseId },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
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
      title: 'Course finie',
      body: 'Bravo !',
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
      body: input.courseReference,
      data: { courseId: input.courseId, annulee_par: input.cancelledBy },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  notifyAutoPaused(input: {
    delivererId: string;
    refusalCount: number;
    windowMinutes: number;
    durationMinutes: number;
    /** Fin de la pause automatique (sinon maintenant + durée). */
    jusqua?: Date;
  }): void {
    const fin = input.jusqua ?? new Date(Date.now() + input.durationMinutes * 60_000);
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'auto_paused',
      title: 'Pause automatique',
      body: `Jusqu'à ${heureCourteAbidjan(fin)}`,
      data: { jusqua: fin.toISOString(), refus: input.refusalCount, minutes: input.durationMinutes },
      critical: true,
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
    });
  }

  /**
   * L'appli a demandé « disponible » pendant une pause (ancienne appli qui se
   * croit disponible à l'ouverture) : le serveur garde la pause et le dit au
   * livreur. Au plus une fois toutes les 30 minutes (DisponibiliteLivreurService).
   */
  notifyRappelPause(input: { delivererId: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'pause_rappel',
      title: 'Tu es en pause',
      body: 'Tu es en pause. Touche Reprendre pour recevoir des courses.',
      data: {},
    });
  }

  /** Offre ignorée sans aucun signal depuis longtemps : le serveur a mis le livreur en pause. */
  notifyMisEnPause(input: { delivererId: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'mis_en_pause',
      title: 'Tu as été mis en pause',
      body: 'Tu as été mis en pause : touche Reprendre pour recevoir des courses.',
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

  /**
   * Un geste du restaurant sur un planning envoyé ou confirmé (conception du
   * 24/10, 11.6). `plan_sent` quand il y a un créneau à confirmer, sinon
   * `plan_modifie` : l'appli actuelle ne connaît pas ce type, elle affiche la
   * notification et l'ouvre sans écran particulier.
   */
  notifyPlanModifie(input: {
    delivererId: string;
    planId: string;
    type: Extract<DelivererPushType, 'plan_sent' | 'plan_modifie'>;
    titre: string;
    texte: string;
  }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: input.type,
      title: input.titre,
      body: input.texte,
      data: { planId: input.planId },
    });
  }

  notifyPresenceCheck(input: { delivererId: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'presence_check',
      title: 'Présence',
      body: "Tu travailles aujourd'hui ?",
      data: {},
    });
  }

  notifyAccountRejected(input: { delivererId: string; reason?: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'account_rejected',
      title: 'Candidature refusée',
      body: input.reason
        ? `Ta demande a été refusée : ${input.reason}`
        : "Ta demande d'inscription a été refusée. Contacte le support pour plus d'informations.",
      data: {},
      critical: true,
    });
  }

  notifyAccountSuspended(input: { delivererId: string; reason?: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'account_suspended',
      title: 'Compte suspendu',
      body: input.reason
        ? `Ton compte a été suspendu : ${input.reason}`
        : 'Ton compte a été suspendu. Contacte le support pour plus d\'informations.',
      data: {},
      critical: true,
    });
  }

  notifyAccountReactivated(input: { delivererId: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'account_reactivated',
      title: 'Compte réactivé ✅',
      body: 'Ton compte est à nouveau actif. Tu peux recommencer à recevoir des courses.',
      data: {},
      critical: true,
    });
  }

  /**
   * Le service client appelle le livreur (demande du 24/10). Envoyée à chaque
   * appel : appli fermée ou en arrière-plan, c'est elle qui le prévient ; appli
   * ouverte, c'est `call:incoming` qui sonne et l'appli la tait. Une appli qui
   * ne sait pas encore répondre dans l'appli donne le numéro à rappeler.
   */
  notifyAppelEntrant(input: { delivererId: string; callId: string }): void {
    this.fireAndForget({
      delivererId: input.delivererId,
      type: 'appel_entrant',
      title: "Le service client t'appelle",
      body: "Ouvre l'appli pour répondre, ou rappelle le 27 21 71 21 30.",
      data: { callId: input.callId },
      critical: true,
      channelId: CANAL_APPELS,
      sound: SON_APPEL,
    });
  }
}
