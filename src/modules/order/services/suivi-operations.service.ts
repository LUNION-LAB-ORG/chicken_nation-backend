import { Injectable, Logger, Optional } from '@nestjs/common';

import {
  CLES_REGLAGES_PLANIFICATION,
  lireReglagesPlanification,
  REGLAGES_PLANIFICATION_DEFAUT,
} from 'src/modules/course/helpers/planification.rules';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { FinsSocketLivreursService } from 'src/socket-io/services/fins-socket-livreurs.service';

import {
  CLE_APPLI_FERMEE_APRES_S,
  CLE_FACTEUR_RETARD,
  enrichirCommandesOperations,
  lireAppliFermeeApresS,
  lireFacteurRetard,
  livreursDesCommandes,
} from '../helpers/suivi-operations.rules';

/**
 * Écran Opérations : offre en attente nommée et fin de la fenêtre d'ajout
 * après le retrait (prolongée tant que la course attend son sac), tournée
 * (« 1 sur 3 livrée », fin prévue, retard) et appli du livreur, ajoutées à
 * chaque course (`suivi-operations.rules.ts`).
 *
 * Les réglages sont relus à chaque appel, en une lecture, comme partout
 * ailleurs ; illisibles, les valeurs par défaut s'appliquent. La présence des
 * applis (sockets ouverts) est demandée une seule fois pour tous les livreurs
 * de la liste, comme la liste des livreurs ; sans réponse, elle est inconnue.
 * La fin du dernier socket des livreurs sans socket ouvert est lue de même,
 * une fois (« Appli fermée » ou « Connexion coupée », 25/10).
 */
@Injectable()
export class SuiviOperationsService {
  private readonly logger = new Logger(SuiviOperationsService.name);

  constructor(
    private readonly settings: SettingsService,
    @Optional() private readonly gateway?: AppGateway,
    @Optional() private readonly fins?: FinsSocketLivreursService,
  ) {}

  async enrichir<C extends object>(commandes: C[], maintenant = new Date()): Promise<C[]> {
    let fenetreMaxS = REGLAGES_PLANIFICATION_DEFAUT.ajoutApresRetraitMaxS;
    let departRayonM = REGLAGES_PLANIFICATION_DEFAUT.departRayonM;
    let facteurRetard = lireFacteurRetard(undefined);
    let appliFermeeApresS = lireAppliFermeeApresS(undefined);
    try {
      const valeurs = await this.settings.getMany([
        ...CLES_REGLAGES_PLANIFICATION,
        CLE_FACTEUR_RETARD,
        CLE_APPLI_FERMEE_APRES_S,
      ]);
      const { reglages } = lireReglagesPlanification(valeurs);
      fenetreMaxS = reglages.ajoutApresRetrait ? reglages.ajoutApresRetraitMaxS : 0;
      departRayonM = reglages.departRayonM;
      facteurRetard = lireFacteurRetard(valeurs[CLE_FACTEUR_RETARD]);
      appliFermeeApresS = lireAppliFermeeApresS(valeurs[CLE_APPLI_FERMEE_APRES_S]);
    } catch (err) {
      this.logger.warn(`Réglages de l'écran Opérations illisibles : ${(err as Error)?.message ?? err}`);
    }
    const ids = livreursDesCommandes(commandes);
    const connectes = await this.presence(ids);
    const finsSocket = appliFermeeApresS > 0 ? await this.finsDe(ids, connectes) : null;
    return enrichirCommandesOperations(commandes, {
      maintenant,
      fenetreMaxS,
      departRayonM,
      facteurRetard,
      appli: { appliFermeeApresS, connectes, finsSocket },
    });
  }

  /** Fin du dernier socket des livreurs sans socket ouvert ; null : illisible, aucune preuve. */
  private async finsDe(ids: string[], connectes: ReadonlySet<string> | null) {
    if (ids.length === 0) return new Map();
    if (!this.fins) return null;
    try {
      return await this.fins.lireSansSocket(ids, connectes);
    } catch {
      return null;
    }
  }

  /** Sockets ouverts parmi ces livreurs ; `null` si la présence n'a pas pu être lue. */
  private async presence(ids: string[]): Promise<Set<string> | null> {
    if (ids.length === 0) return new Set();
    if (!this.gateway) return null;
    try {
      return await this.gateway.livreursConnectes(ids);
    } catch {
      return null;
    }
  }
}
