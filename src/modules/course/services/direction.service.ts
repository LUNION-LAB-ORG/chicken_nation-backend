import { Injectable, Logger } from '@nestjs/common';

import { MapsService } from 'src/modules/maps/maps.service';
import { SettingsService } from 'src/modules/settings/settings.service';

import {
  ClientDirection,
  CLES_REGLAGES_DIRECTION,
  compatibiliteGroupe,
  compatibilitePaire,
  lireReglagesDirection,
  MesurerDetour,
  ReglagesDirectionLus,
  VerdictGroupe,
  VerdictPaire,
} from '../helpers/direction.rules';
import { ILatLng, parseOrderLatLng } from '../helpers/geo.helper';
import { decoderPolyligne } from '../helpers/polyligne';

/** Un même avertissement de réglage au plus une fois par minute. */
const INTERVALLE_JOURNAL_MS = 60 * 1000;

/** Ce que la direction lit d'une commande. */
export interface CommandeDirection {
  id: string;
  /** `Order.address` : objet ou chaîne JSON (`parseOrderLatLng`). */
  address: unknown;
}

/**
 * Pont entre la règle « même direction » (`direction.rules.ts`, pure) et ses
 * données : coordonnées des commandes, distance routière et tracé
 * (`MapsService.itineraireRoutier`, cache 30 jours), détour réel
 * (`MapsService.detourSansTrafic`) et réglages `course.direction_*`.
 *
 * Sans état : tout est relu à chaque appel. Ne lève jamais à cause de
 * Google : clé absente, délai dépassé, plafond atteint ou réglage
 * `course.direction_google` à 0, la règle passe à son repli sans carte.
 */
@Injectable()
export class DirectionService {
  private readonly logger = new Logger(DirectionService.name);
  private readonly derniersJournaux = new Map<string, number>();

  constructor(
    private readonly maps: MapsService,
    private readonly settings: SettingsService,
  ) {}

  /** Réglages de direction ; une valeur refusée est remplacée par son défaut et journalisée. */
  async reglages(): Promise<ReglagesDirectionLus> {
    let valeurs: Record<string, string> = {};
    try {
      valeurs = await this.settings.getMany(Object.values(CLES_REGLAGES_DIRECTION));
    } catch (erreur) {
      this.journaliserUneFois('base', `[Direction] Réglages illisibles (${(erreur as Error).message}) : défauts appliqués.`);
    }
    const lus = lireReglagesDirection(valeurs);
    for (const { cle, valeur } of lus.refusees) {
      this.journaliserUneFois(cle, `[Direction] Valeur refusée pour ${cle} : « ${valeur} ». Défaut appliqué.`);
    }
    return lus;
  }

  /**
   * Une commande vue par la règle de direction : ses coordonnées et, si
   * Google est permis, sa distance routière et son tracé depuis le
   * restaurant (le plus souvent en cache : c'est l'appel des frais).
   *
   * `Order.delivery_distance_km` n'est pas lu : il peut venir du repli au
   * vol d'oiseau redressé des frais, et le comparer à une distance routière
   * serait le mélange que la règle interdit.
   */
  async client(restaurant: ILatLng | null, commande: CommandeDirection, google: boolean): Promise<ClientDirection> {
    const position = parseOrderLatLng(commande.address);
    const sansRoute: ClientDirection = { id: commande.id, position, routeMetres: null, trace: null };
    if (!restaurant || !position || !google) return sansRoute;

    try {
      const itineraire = await this.maps.itineraireRoutier(
        {
          originLat: restaurant.lat,
          originLng: restaurant.lng,
          destLat: position.lat,
          destLng: position.lng,
        },
        // Budget du regroupement (plafonné), jamais celui des frais de livraison.
        { pour: 'direction' },
      );
      if (!itineraire) return sansRoute;
      const trace = decoderPolyligne(itineraire.polyligne);
      return {
        id: commande.id,
        position,
        routeMetres: itineraire.metres,
        trace: trace.length >= 2 ? trace : null,
      };
    } catch (erreur) {
      // `itineraireRoutier` ne lève jamais ; filet pour le jour où on l'oublie.
      this.journaliserUneFois('itineraire', `[Direction] Itinéraire en échec : ${(erreur as Error).message}`);
      return sansRoute;
    }
  }

  /** Plusieurs commandes d'un même restaurant, en parallèle. */
  async clients(restaurant: ILatLng | null, commandes: readonly CommandeDirection[], google: boolean): Promise<ClientDirection[]> {
    return Promise.all(commandes.map((c) => this.client(restaurant, c, google)));
  }

  /** Mesure du détour par Google, ou `undefined` si Google est coupé par réglage. */
  mesureurDetour(google: boolean): MesurerDetour | undefined {
    if (!google) return undefined;
    return (restaurant, proche, lointain) =>
      this.maps.detourSansTrafic({
        restaurant: { latitude: restaurant.lat, longitude: restaurant.lng },
        proche: { latitude: proche.lat, longitude: proche.lng },
        lointain: { latitude: lointain.lat, longitude: lointain.lng },
      });
  }

  /** Compatibilité de deux clients (tests 1 à 7), détour mesuré au besoin. */
  async verdictPaire(
    restaurant: ILatLng | null,
    a: ClientDirection,
    b: ClientDirection,
    lus?: ReglagesDirectionLus,
  ): Promise<VerdictPaire> {
    const { reglages, google } = lus ?? (await this.reglages());
    return compatibilitePaire(restaurant, a, b, reglages, this.mesureurDetour(google));
  }

  /** Validité d'un groupe et ordre de ses arrêts. */
  async verdictGroupe(
    restaurant: ILatLng | null,
    clients: readonly ClientDirection[],
    lus?: ReglagesDirectionLus,
  ): Promise<VerdictGroupe> {
    const { reglages, google } = lus ?? (await this.reglages());
    return compatibiliteGroupe(restaurant, clients, reglages, this.mesureurDetour(google));
  }

  private journaliserUneFois(sujet: string, message: string): void {
    const maintenant = Date.now();
    if (maintenant - (this.derniersJournaux.get(sujet) ?? 0) < INTERVALLE_JOURNAL_MS) return;
    this.derniersJournaux.set(sujet, maintenant);
    this.logger.warn(message);
  }
}
