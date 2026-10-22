import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'src/database/services/prisma.service';
import { DispatchJournalService } from 'src/modules/course/services/dispatch-journal.service';
import {
  MotifClotureOffre,
  OffresClotureService,
} from 'src/modules/course/services/offres-cloture.service';

import { PauseDelivererDto } from '../dto/pause-deliverer.dto';
import { DelivererEvent } from '../events/deliverer.event';
import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import {
  FIN_PAUSE_INDEFINIE,
  estEnPause,
  estEnPauseAuto,
  messagePauseAuto,
} from '../helpers/disponibilite.rules';
import { DelivererPushService } from './deliverer-push.service';

/** Au plus un rappel « Tu es en pause » toutes les 30 minutes. */
export const INTERVALLE_RAPPEL_PAUSE_MS = 30 * 60_000;

/** Réponse de `POST /deliverers/me/available`. */
export interface ReponseDisponible {
  id: string;
  restaurant_id: string | null;
  /** Vrai : le livreur est en pause (manuelle ou automatique), rien n'a changé. */
  en_pause: boolean;
  pause_until: Date | null;
  auto_pause_until: Date | null;
  /** Entrée dans la file (null = hors service). */
  last_available_at: Date | null;
}

/**
 * DISPONIBILITÉ DU LIVREUR : pause, reprise, entrée dans la file, déconnexion,
 * mise hors service. La pause enregistrée au serveur est la seule vérité
 * (demande du 22/10 : un livreur en pause ne reçoit aucune course).
 *
 *  - pause : sortie de la file, offres en attente closes sans pénalité ;
 *  - reprise : lève la pause MANUELLE seulement ; une pause automatique
 *    (sanction) reste jusqu'à son terme (409) ;
 *  - disponible : ne lève JAMAIS une pause. L'ancienne appli l'appelle à
 *    chaque ouverture de l'accueil en se croyant disponible : pendant une
 *    pause, rien ne change, la réponse le dit (200, `en_pause`) et le livreur
 *    reçoit un rappel. Hors pause, il garde sa place dans la file ;
 *  - déconnexion, et filet pour les téléphones oubliés : hors service, pause
 *    « jusqu'à Reprendre », offres closes.
 *
 * Chaque décision est écrite au journal de la diffusion.
 */
@Injectable()
export class DisponibiliteLivreurService {
  private readonly logger = new Logger(DisponibiliteLivreurService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivererEvent: DelivererEvent,
    private readonly pushService: DelivererPushService,
    private readonly settings: DelivererScoringSettingsHelper,
    private readonly cloture: OffresClotureService,
    private readonly journal: DispatchJournalService,
  ) {}

  /**
   * Bouton « Pause » de l'appli. Sans durée : pause jusqu'à « Reprendre ».
   * Sort de la file et clôt les offres en attente (sans pénalité, la course
   * repart vers un autre livreur).
   */
  async mettreEnPause(delivererId: string, dto: PauseDelivererDto, maintenant = new Date()) {
    const pauseUntil = dto.durationMinutes
      ? new Date(maintenant.getTime() + dto.durationMinutes * 60_000)
      : FIN_PAUSE_INDEFINIE;

    const livreur = await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { pause_until: pauseUntil, last_available_at: null },
      select: { id: true, pause_until: true, last_available_at: true, restaurant_id: true },
    });

    await this.clore(delivererId, 'LIVREUR_EN_PAUSE');
    await this.journal.ecrire({
      type: 'PAUSE',
      source: 'appli',
      deliverer_id: delivererId,
      restaurant_id: livreur.restaurant_id,
      details: { jusqua: dto.durationMinutes ? pauseUntil.toISOString() : 'reprise' },
    });
    this.delivererEvent.queueChanged(livreur.id, livreur.restaurant_id);
    return livreur;
  }

  /**
   * Bouton « Reprendre » (premier appel). Lève la pause manuelle SEULEMENT.
   * Ne remet pas dans la file : l'appli appelle ensuite `/available`.
   *
   * @throws ConflictException pendant une pause automatique : « Pause
   *   automatique jusqu'à 14 h 32. »
   */
  async reprendre(delivererId: string, maintenant = new Date()) {
    const avant = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { id: true, restaurant_id: true, pause_until: true, auto_pause_until: true },
    });
    if (!avant) throw new NotFoundException('Livreur non trouvé');

    if (estEnPauseAuto(avant, maintenant)) {
      await this.journal.ecrire({
        type: 'REPRISE_REFUSEE_PAUSE_AUTO',
        source: 'appli',
        deliverer_id: delivererId,
        restaurant_id: avant.restaurant_id,
        details: { pause_auto_jusqua: avant.auto_pause_until?.toISOString() },
      });
      throw new ConflictException(messagePauseAuto(avant.auto_pause_until!, maintenant));
    }

    const livreur = await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { pause_until: null },
      select: { id: true, pause_until: true, auto_pause_until: true, restaurant_id: true },
    });

    await this.journal.ecrire({
      type: 'REPRISE',
      source: 'appli',
      deliverer_id: delivererId,
      restaurant_id: livreur.restaurant_id,
      details: { etait_en_pause: estEnPause(avant, maintenant) },
    });
    this.delivererEvent.queueChanged(livreur.id, livreur.restaurant_id);
    return livreur;
  }

  /**
   * « Je suis disponible » (second appel de « Reprendre », et ouverture de
   * l'ancienne appli).
   *
   *  - En pause (manuelle ou automatique) : AUCUN changement. Réponse 200
   *    `{ en_pause: true, pause_until, auto_pause_until }` (l'ancienne appli
   *    n'affiche pas d'erreur), rappel « Tu es en pause » au plus une fois
   *    toutes les 30 minutes, journal `DISPONIBLE_REFUSE_EN_PAUSE`.
   *  - Sinon : `last_available_at = coalesce(last_available_at, maintenant)`.
   *    Rouvrir l'appli ne fait plus perdre sa place dans la file.
   */
  async marquerDisponible(delivererId: string, maintenant = new Date()): Promise<ReponseDisponible> {
    const livreur = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: {
        id: true,
        restaurant_id: true,
        pause_until: true,
        auto_pause_until: true,
        last_available_at: true,
      },
    });
    if (!livreur) throw new NotFoundException('Livreur non trouvé');

    if (estEnPause(livreur, maintenant) || estEnPauseAuto(livreur, maintenant)) {
      const rappelEnvoye = await this.envoyerRappelPause(delivererId, maintenant);
      await this.journal.ecrire({
        type: 'DISPONIBLE_REFUSE_EN_PAUSE',
        motif: estEnPause(livreur, maintenant) ? 'EN_PAUSE' : 'PAUSE_AUTO',
        source: 'appli',
        deliverer_id: delivererId,
        restaurant_id: livreur.restaurant_id,
        details: { rappel_envoye: rappelEnvoye },
      });
      return { ...livreur, en_pause: true };
    }

    // Entrée dans la file seulement si le livreur n'y est pas déjà, et toujours
    // hors pause : une pause posée entre la lecture et l'écriture l'emporte.
    const entree = await this.prisma.deliverer.updateMany({
      where: {
        id: delivererId,
        last_available_at: null,
        AND: [
          { OR: [{ pause_until: null }, { pause_until: { lte: maintenant } }] },
          { OR: [{ auto_pause_until: null }, { auto_pause_until: { lte: maintenant } }] },
        ],
      },
      data: { last_available_at: maintenant },
    });

    if (entree.count === 1) {
      await this.journal.ecrire({
        type: 'DISPONIBLE',
        source: 'appli',
        deliverer_id: delivererId,
        restaurant_id: livreur.restaurant_id,
      });
      this.delivererEvent.queueChanged(livreur.id, livreur.restaurant_id);
      return { ...livreur, last_available_at: maintenant, en_pause: false };
    }
    return { ...livreur, en_pause: false };
  }

  /**
   * Déconnexion de l'appli : hors service (sorti de la file, pause « jusqu'à
   * Reprendre »), jeton de notification effacé (plus aucune notification
   * d'offre sur ce téléphone), offres en attente closes.
   */
  async deconnecter(delivererId: string) {
    const livreur = await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { last_available_at: null, pause_until: FIN_PAUSE_INDEFINIE, expo_push_token: null },
      select: { id: true, restaurant_id: true },
    });

    await this.clore(delivererId, 'LIVREUR_DECONNECTE');
    await this.journal.ecrire({
      type: 'DECONNEXION',
      source: 'appli',
      deliverer_id: delivererId,
      restaurant_id: livreur.restaurant_id,
    });
    this.delivererEvent.queueChanged(livreur.id, livreur.restaurant_id);
  }

  /**
   * FILET pour l'ancienne appli et les téléphones oubliés, appelé quand un
   * livreur laisse expirer une offre : sans aucun signal (position ou requête
   * authentifiée) depuis `deliverer.hors_service_sans_signal_min` minutes
   * (0 = coupé), il passe hors service (pause « jusqu'à Reprendre ») et reçoit
   * « Tu as été mis en pause : touche Reprendre pour recevoir des courses. ».
   * Un absent coûte une offre, plus trois.
   *
   * Réservation atomique (deux serveurs) : vrai si CET appel l'a mis hors service.
   */
  async mettreHorsServiceSiSansSignal(delivererId: string, maintenant = new Date()): Promise<boolean> {
    const { horsServiceSansSignalMin } = await this.settings.load();
    if (horsServiceSansSignalMin <= 0) return false;

    const seuil = new Date(maintenant.getTime() - horsServiceSansSignalMin * 60_000);
    const reserve = await this.prisma.deliverer.updateMany({
      where: {
        id: delivererId,
        // Aucun signe de vie depuis le seuil. Signal jamais noté (champ ajouté
        // le 22/10, rempli à la première requête ou position) : la dernière
        // position connue en tient lieu. Sinon, juste après le déploiement,
        // un livreur qui venait d'envoyer sa position passerait hors service
        // à sa première offre manquée.
        OR: [
          { dernier_signal_at: { lt: seuil } },
          {
            dernier_signal_at: null,
            OR: [{ last_location_at: null }, { last_location_at: { lt: seuil } }],
          },
        ],
        // Déjà en pause : rien à faire (et pas de second message).
        AND: [{ OR: [{ pause_until: null }, { pause_until: { lte: maintenant } }] }],
      },
      data: { last_available_at: null, pause_until: FIN_PAUSE_INDEFINIE },
    });
    if (reserve.count !== 1) return false;

    const livreur = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { id: true, restaurant_id: true, dernier_signal_at: true },
    });

    await this.clore(delivererId, 'LIVREUR_HORS_SERVICE');
    this.pushService.notifyMisEnPause({ delivererId });
    await this.journal.ecrire({
      type: 'HORS_SERVICE_SANS_SIGNAL',
      source: 'serveur',
      deliverer_id: delivererId,
      restaurant_id: livreur?.restaurant_id ?? null,
      details: {
        dernier_signal: livreur?.dernier_signal_at?.toISOString() ?? null,
        seuil_min: horsServiceSansSignalMin,
      },
    });
    this.delivererEvent.queueChanged(delivererId, livreur?.restaurant_id ?? null);
    return true;
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  /** Rappel « Tu es en pause », réservé atomiquement : au plus un par 30 min, même à deux serveurs. */
  private async envoyerRappelPause(delivererId: string, maintenant: Date): Promise<boolean> {
    const limite = new Date(maintenant.getTime() - INTERVALLE_RAPPEL_PAUSE_MS);
    const reserve = await this.prisma.deliverer.updateMany({
      where: {
        id: delivererId,
        OR: [{ rappel_pause_at: null }, { rappel_pause_at: { lte: limite } }],
      },
      data: { rappel_pause_at: maintenant },
    });
    if (reserve.count !== 1) return false;
    this.pushService.notifyRappelPause({ delivererId });
    return true;
  }

  /**
   * Clôt les offres en attente du livreur. Une erreur ici ne doit pas annuler
   * la pause déjà enregistrée : l'offre restante sera close à sa relance ou
   * expirera sans pénalité.
   */
  private async clore(delivererId: string, motif: MotifClotureOffre) {
    try {
      await this.cloture.clorePourLivreur(delivererId, motif, {
        source: motif === 'LIVREUR_HORS_SERVICE' ? 'serveur' : 'appli',
      });
    } catch (err) {
      this.logger.error(
        `Clôture des offres de ${delivererId.slice(0, 8)} (${motif}) impossible : ${(err as Error)?.message}`,
      );
    }
  }
}
