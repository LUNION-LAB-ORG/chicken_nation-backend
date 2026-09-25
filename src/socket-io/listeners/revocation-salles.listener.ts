import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import { AppGateway } from '../gateways/app.gateway';
import { restaurantSuiviParLivreur } from '../utils/salles.util';

/** Ce que le module livreurs transmet avec `deliverer:operational:changed`. */
interface LivreurModifie {
  deliverer?: {
    id?: string;
    restaurant_id?: string | null;
    entity_status?: string | null;
  } | null;
}

/** Ce que le module utilisateurs transmet avec `user.deactivated` et `user.deleted`. */
interface CompteDuPersonnel {
  data?: { id?: string } | null;
}

/**
 * Tient les salles à jour quand un compte change après la connexion.
 *
 * Les salles sont fixées à la connexion du socket. Sans cet écouteur, un
 * livreur réaffecté restait dans la salle des livreurs de son ancien restaurant
 * et n'entendait pas la file du nouveau ; un livreur supprimé restait dans
 * celle de son restaurant ; un compte du personnel désactivé ou supprimé
 * continuait de recevoir `backoffice_all` ou la salle de son restaurant, tant
 * que son appareil ne se reconnectait pas.
 *
 * Écoute les événements internes déjà émis par les modules livreurs
 * (affectation à un restaurant, suppression, suppression programmée ou
 * annulée, tout changement de statut) et utilisateurs (suspension et
 * suppression d'un compte) : aucun couplage direct avec ces modules.
 *
 * Non couverts : la purge automatique d'un livreur dont la suppression
 * programmée arrive à échéance (aucun événement émis ; il ne garde que la
 * salle de la file d'attente, qui ne porte que des identifiants de livreurs),
 * et le changement de restaurant ou de type d'un compte du personnel resté
 * actif (aucun événement émis non plus).
 *
 * Sans risque pour le traitement en cours : une erreur (Redis indisponible,
 * délai de réponse d'une autre instance dépassé) est journalisée et ne
 * remonte jamais au flux métier.
 */
@Injectable()
export class RevocationSallesListener {
  private readonly logger = new Logger(RevocationSallesListener.name);

  constructor(private readonly appGateway: AppGateway) { }

  @OnEvent(DelivererChannels.DELIVERER_OPERATIONAL_CHANGED)
  async surLivreurModifie(payload: LivreurModifie): Promise<void> {
    const livreur = payload?.deliverer;
    if (!livreur?.id) return;
    try {
      await this.appGateway.resynchroniserSallesLivreur(
        livreur.id,
        restaurantSuiviParLivreur(livreur),
      );
    } catch (error) {
      this.logger.warn(
        `Salles du livreur ${livreur.id} non resynchronisées : ${(error as Error)?.message}`,
      );
    }
  }

  @OnEvent('user.deactivated')
  surCompteDesactive(payload: CompteDuPersonnel): void {
    this.deconnecter(payload);
  }

  @OnEvent('user.deleted')
  surCompteSupprime(payload: CompteDuPersonnel): void {
    this.deconnecter(payload);
  }

  private deconnecter(payload: CompteDuPersonnel): void {
    const id = payload?.data?.id;
    if (!id) return;
    try {
      this.appGateway.deconnecterUtilisateur(id);
    } catch (error) {
      this.logger.warn(
        `Sockets du compte ${id} non coupés : ${(error as Error)?.message}`,
      );
    }
  }
}
