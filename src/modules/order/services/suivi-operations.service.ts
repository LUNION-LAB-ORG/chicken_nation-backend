import { Injectable, Logger } from '@nestjs/common';

import {
  CLES_REGLAGES_PLANIFICATION,
  lireReglagesPlanification,
  REGLAGES_PLANIFICATION_DEFAUT,
} from 'src/modules/course/helpers/planification.rules';
import { SettingsService } from 'src/modules/settings/settings.service';

import { enrichirCommandesOperations } from '../helpers/suivi-operations.rules';

/**
 * Écran Opérations : offre en attente nommée et fin de la fenêtre d'ajout
 * après le retrait, ajoutées à chaque course (`suivi-operations.rules.ts`).
 * Le réglage est relu à chaque appel, comme partout ailleurs ; s'il est
 * illisible, la valeur par défaut s'applique.
 */
@Injectable()
export class SuiviOperationsService {
  private readonly logger = new Logger(SuiviOperationsService.name);

  constructor(private readonly settings: SettingsService) {}

  async enrichir<C extends object>(commandes: C[], maintenant = new Date()): Promise<C[]> {
    let fenetreMaxS = REGLAGES_PLANIFICATION_DEFAUT.ajoutApresRetraitMaxS;
    try {
      const { reglages } = lireReglagesPlanification(await this.settings.getMany([...CLES_REGLAGES_PLANIFICATION]));
      fenetreMaxS = reglages.ajoutApresRetrait ? reglages.ajoutApresRetraitMaxS : 0;
    } catch (err) {
      this.logger.warn(`Réglages du planificateur illisibles : ${(err as Error)?.message ?? err}`);
    }
    return enrichirCommandesOperations(commandes, { maintenant, fenetreMaxS });
  }
}
