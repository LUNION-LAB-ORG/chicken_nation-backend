import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

/**
 * Ce qui se passe dans la diffusion des offres, une ligne par décision.
 * Ajouter un type ici suffit : la colonne est un texte, sans migration.
 */
export type TypeEvenementDispatch =
  // Offres
  | 'OFFRE_PROPOSEE'
  | 'OFFRE_ACCEPTEE'
  | 'OFFRE_REFUSEE'
  | 'OFFRE_EXPIREE'
  /** Close par le serveur, sans pénalité ; `motif` = MotifClotureOffre. */
  | 'OFFRE_CLOSE'
  /** Acceptation refusée (course plus disponible) ; `motif` = raison. */
  | 'ACCEPTATION_REFUSEE'
  /** Affectation forcée refusée par la règle ; `motif` = MotifRefusOffre. */
  | 'AFFECTATION_FORCEE_REFUSEE'
  // Livreur
  | 'PAUSE'
  | 'REPRISE'
  | 'REPRISE_REFUSEE_PAUSE_AUTO'
  /** Entrée dans la file (« Reprendre », ou ouverture de l'ancienne appli). */
  | 'DISPONIBLE'
  /** `/available` pendant une pause : rien ne change (ancienne appli). */
  | 'DISPONIBLE_REFUSE_EN_PAUSE'
  | 'DECONNEXION'
  /** Offre ignorée sans aucun signal depuis le seuil réglé. */
  | 'HORS_SERVICE_SANS_SIGNAL'
  /**
   * Appli fermée par le livreur (ni socket ni signe de vie depuis
   * `deliverer.appli_fermee_apres_s`, et son dernier socket fermé par l'appli
   * elle-même) : plus d'offre jusqu'à sa réouverture. `details.appli_vue_a` :
   * dernier signe de vie ; `details.raison_socket`, `details.fin_socket_a` :
   * fin du dernier socket.
   */
  | 'APPLI_FERMEE'
  /**
   * Connexion coupée (25/10) : même silence, sans preuve de fermeture (réseau
   * coupé, téléphone qui gèle ou arrête l'appli). Mêmes effets, mêmes
   * `details` ; `raison_socket` : `ping timeout`, `transport close`… ou null.
   */
  | 'CONNEXION_COUPEE'
  /**
   * Appli de retour après un passage `APPLI_FERMEE` ou `CONNEXION_COUPEE` ;
   * `details.fermee_a`, `details.par` (socket ou signal).
   */
  | 'APPLI_ACTIVE'
  /** Remis dans la file après la perte de sa course (fusion, annulation). */
  | 'REMIS_EN_FILE'
  // Course
  /** Bouton de la caisse « Livreur a récupéré » : course passée IN_DELIVERY. */
  | 'COURSE_EN_LIVRAISON_PAR_CAISSE'
  /** Même bouton sur une course encore SANS livreur : rien ne change, à surveiller. */
  | 'REMISE_CAISSE_SANS_LIVREUR'
  /** Annulation automatique d'une course : les commandes des clients sont gardées. */
  | 'ANNULATION_AUTO_COMMANDES_GARDEES'
  /** Course sans livreur dont toutes les commandes ont été annulées : annulée par le planificateur. */
  | 'COURSE_VIDE_ANNULEE'
  // Planificateur v2 (une ligne par action, `motif` = raison de la décision)
  /** Course créée par le planificateur ; `motif` = direction (SUR_LE_TRAJET, MEME_ZONE…) ou SEULE. */
  | 'COURSE_CREEE'
  /** Commande ajoutée à une course ouverte ; `details.apres_retrait`, `details.attendue`. */
  | 'COMMANDE_AJOUTEE'
  /** Course sans livreur absorbée par une autre ; son offre close sans pénalité. */
  | 'COURSES_FUSIONNEES'
  /** Ordre des arrêts recalculé. */
  | 'ARRETS_ORDONNES'
  /** Course proposée par le planificateur ; `motif` = AU_COMPTOIR ou MINUTES. */
  | 'OFFRE_PLANIFIEE'
  /** Départ retenu au comptoir pour une commande en préparation ; `motif` = ATTENTE_COURTE ou TRAJET_LONG. */
  | 'COURSE_RETENUE'
  /** Retenue levée ; `motif` = TOUT_PRET, ECHEANCE, PLUS_RIEN_A_ATTENDRE, PARTI, REPLI_V1. */
  | 'RETENUE_LEVEE'
  /** Course réputée partie du restaurant ; `motif` = POSITION, BOUTON, FENETRE_ECHUE… */
  | 'COURSE_PARTIE'
  /** Commande ajoutée après le retrait, pas remise : retirée de la course au départ. */
  | 'COMMANDE_DETACHEE'
  /** Course partie alors qu'une commande d'origine est encore prête au comptoir ; cloche au restaurant et au siège. */
  | 'DEPART_SANS_COMMANDE'
  /** Commande remise avec le même code après le retrait (livreur encore au restaurant). */
  | 'RETRAIT_COMPLEMENTAIRE'
  /** Course confiée à Turbo par le planificateur (dernier recours). */
  | 'TURBO_PLANIFIE'
  /** Action abandonnée : la course ou la commande a changé entre la lecture et l'écriture. */
  | 'ACTION_ABANDONNEE'
  /**
   * Refus du planificateur (ajout, fusion, retenue), observation seulement :
   * `motif` = MotifRefusPlanification ; `details.essai`, `details.course_cle`
   * (clé du plan), `details.source_id` (course absorbée d'une fusion),
   * `details.libelle`. Un même refus au plus une fois par 10 min et par serveur.
   */
  | 'PLAN_REFUS'
  /** Fin de préparation estimée comparée à la réelle (commande prête). */
  | 'PREPARATION_MESUREE'
  /** Arrivée au restaurant déduite d'une position (appli en arrière-plan). */
  | 'ARRIVEE_RESTAURANT_AUTO'
  /** Arrivée chez le client déduite d'une position (appli en arrière-plan). */
  | 'ARRIVEE_CLIENT_AUTO';

/** Qui a déclenché la décision. */
export type SourceDispatch = 'appli' | 'serveur' | 'admin' | 'caisse' | 'restaurant';

export interface EvenementDispatch {
  type: TypeEvenementDispatch;
  motif?: string | null;
  source?: SourceDispatch;
  restaurant_id?: string | null;
  course_id?: string | null;
  deliverer_id?: string | null;
  order_id?: string | null;
  offre_id?: string | null;
  /** Données libres utiles aux mesures (références, échéances…). */
  details?: Record<string, unknown>;
}

/**
 * JOURNAL DE LA DIFFUSION : une ligne JSON dans les journaux du conteneur
 * (niveau `log`, le niveau `debug` est coupé en production) et la même chose
 * dans la table `DispatchEvenement`, source des mesures (les journaux Docker
 * ne gardent que 30 Mo).
 *
 * N'échoue JAMAIS : une erreur d'écriture est journalisée et avalée, l'action
 * métier continue. Les appelants peuvent donc l'attendre sans `try`, ou la
 * lancer sans l'attendre (`void this.journal.ecrire(...)`).
 */
@Injectable()
export class DispatchJournalService {
  private readonly logger = new Logger('Dispatch');

  constructor(private readonly prisma: PrismaService) {}

  async ecrire(evenement: EvenementDispatch): Promise<void> {
    try {
      this.logger.log(JSON.stringify(sansVides(evenement)));
      await this.prisma.dispatchEvenement.create({
        data: {
          type: evenement.type,
          motif: evenement.motif ?? null,
          source: evenement.source ?? null,
          restaurant_id: evenement.restaurant_id ?? null,
          course_id: evenement.course_id ?? null,
          deliverer_id: evenement.deliverer_id ?? null,
          order_id: evenement.order_id ?? null,
          offre_id: evenement.offre_id ?? null,
          details: (evenement.details ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Écriture du journal impossible (${evenement.type}) : ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Plusieurs lignes en une seule insertion (refus d'un passage du
   * planificateur). Même règle que `ecrire` : n'échoue jamais.
   */
  async ecrireTous(evenements: readonly EvenementDispatch[]): Promise<void> {
    if (evenements.length === 0) return;
    try {
      for (const e of evenements) this.logger.log(JSON.stringify(sansVides(e)));
      await this.prisma.dispatchEvenement.createMany({
        data: evenements.map((e) => ({
          type: e.type,
          motif: e.motif ?? null,
          source: e.source ?? null,
          restaurant_id: e.restaurant_id ?? null,
          course_id: e.course_id ?? null,
          deliverer_id: e.deliverer_id ?? null,
          order_id: e.order_id ?? null,
          offre_id: e.offre_id ?? null,
          details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
        })),
      });
    } catch (err) {
      this.logger.warn(
        `Écriture du journal impossible (${evenements.length} lignes ${evenements[0].type}) : ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

/** Ligne de journal compacte : sans les champs vides. */
function sansVides(evenement: EvenementDispatch): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evenement).filter(([, v]) => v !== undefined && v !== null),
  );
}
