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
  // Course
  /** Bouton de la caisse « Livreur a récupéré » : course passée IN_DELIVERY. */
  | 'COURSE_EN_LIVRAISON_PAR_CAISSE'
  /** Annulation automatique d'une course : les commandes des clients sont gardées. */
  | 'ANNULATION_AUTO_COMMANDES_GARDEES';

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
}

/** Ligne de journal compacte : sans les champs vides. */
function sansVides(evenement: EvenementDispatch): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evenement).filter(([, v]) => v !== undefined && v !== null),
  );
}
