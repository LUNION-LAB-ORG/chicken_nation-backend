import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DeliveryService, LoyaltyLevel } from '@prisma/client';
import { JsonValue } from '@prisma/client/runtime/library';
import { SettingsService } from 'src/modules/settings/settings.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { TurboService } from 'src/turbo/services/turbo.service';
import { DeliveryOfferService } from 'src/modules/delivery-offer/services/delivery-offer.service';
import { MapsService } from 'src/modules/maps/maps.service';

/**
 * Un palier de la grille de frais de livraison : tout trajet dont la distance
 * (km, PAR LA ROUTE) est <= `maxKm` est facturé `price`. `maxKm: null` = palier
 * « au-delà » (catch-all, doit être en dernier).
 */
export interface IDeliveryFeeTier {
  maxKm: number | null;
  price: number;
}

export interface IDeliveryFeeSettings {
  /** Si true : on consulte d'abord les zones Turbo, sinon on n'utilise que la grille. */
  turboZonesEnabled: boolean;
  /** Grille distance→prix (paliers), configurable depuis le backoffice. */
  grid: IDeliveryFeeTier[];
  /** Service de livraison par défaut des commandes auto (indépendant des PRIX). */
  defaultService: DeliveryService;
  /** Surcharges PAR RESTAURANT : { [restaurantId]: service }. Absent = défaut. */
  serviceByRestaurant: Record<string, DeliveryService>;
}

/** Résultat d'un calcul de frais de livraison. */
export interface DeliveryFeeResult {
  montant: number;
  zone: string;
  /** Distance restaurant → client, ARRONDIE au kilomètre. Champ d'affichage. */
  distance: number;
  /**
   * Distance exacte, en kilomètres, telle que la grille la calcule.
   *
   * `distance` est arrondie : une course de 2,4 km y devient 2. Un palier
   * « jusqu'à 2 km » l'aurait donc facturée au tarif le plus bas, sur une
   * course qui n'y a pas droit. Les décisions de prix se prennent ici.
   */
  distance_exacte?: number;
  /**
   * D'où vient la distance facturée. `ROUTE` = itinéraire Google, le cas
   * normal. `VOL_OISEAU_CORRIGE` = Google n'a pas répondu, on a appliqué le
   * facteur de détour. Sert à mesurer la fréquence du repli.
   */
  distance_source?: 'ROUTE' | 'VOL_OISEAU_CORRIGE';
  service: DeliveryService;
  zone_id: string | null;
  // Offre de livraison appliquée (le cas échéant)
  offer_id?: string;
  offer_name?: string;
  original_montant?: number; // frais avant offre
  discount?: number; // montant offert sur le frais
}

/** Grille par défaut = exactement l'ancienne grille hardcodée (comportement inchangé). */
export const DELIVERY_FEE_DEFAULT_GRID: IDeliveryFeeTier[] = [
  { maxKm: 2, price: 1000 },
  { maxKm: 4, price: 1500 },
  { maxKm: 5, price: 2000 },
  { maxKm: 7, price: 2500 },
  { maxKm: 10, price: 3000 },
  { maxKm: 12.5, price: 3500 },
  { maxKm: 14, price: 4000 },
  { maxKm: 16, price: 4500 },
  { maxKm: null, price: 5000 },
];

/**
 * Indice de détour : de combien la route rallonge le vol d'oiseau.
 *
 * Sert UNIQUEMENT de repli, quand Google n'a pas pu donner l'itinéraire. Il
 * ne s'agit pas d'une majoration commerciale mais d'un redressement : depuis
 * que les paliers s'entendent PAR LA ROUTE, leur appliquer une distance à vol
 * d'oiseau les décale systématiquement vers le bas, toujours au détriment de
 * la maison. Une valeur de 1 revient à assumer ce biais.
 *
 * 1,3 correspond à ce qu'on observe à Abidjan : lagune, ponts et sens uniques
 * rallongent d'environ un tiers. Réglable par `delivery.facteur_detour`.
 */
const FACTEUR_DETOUR_DEFAUT = 1.3;

const DEFAULTS = {
  turbo_zones_enabled: 1,
  fee_grid: JSON.stringify(DELIVERY_FEE_DEFAULT_GRID),
  default_service: DeliveryService.TURBO,
};

/** Clés `settings` (préfixe `delivery.`). */
export const DELIVERY_FEE_SETTING_KEYS = {
  turboZonesEnabled: 'delivery.turbo_zones_enabled',
  feeGrid: 'delivery.fee_grid',
  defaultService: 'delivery.default_service',
  serviceByRestaurant: 'delivery.service_by_restaurant',
  facteurDetour: 'delivery.facteur_detour',
} as const;

/**
 * SOURCE DE VÉRITÉ UNIQUE des frais de livraison.
 *
 * Réunit la configuration (settings `delivery.*`) ET le calcul du frais.
 * Utilisé par OrderService directement, à la fois pour l'endpoint /frais-livraison
 * (montant affiché par l'app avant paiement) et pour la création de commande
 * (createv2). Une seule implémentation → aucune divergence affichage↔débit.
 * Pas de cache : tout changement backoffice est effectif immédiatement.
 */
@Injectable()
export class DeliveryFeeHelper {
  private readonly logger = new Logger(DeliveryFeeHelper.name);

  /** Zones Turbo par restaurant, mémoïsées 60 s : la grille de zones ne bouge
   *  pas d'une commande à l'autre — évite un appel API Turbo par commande
   *  (création en rafale, rattrapage des frais). TTL court : une mise à jour
   *  de zones côté Turbo converge en ≤ 60 s. */
  private readonly zonesTurboCache = new Map<
    string,
    { zones: Array<{ id: string; name: string; latitude: number; longitude: number; prix: number }>; expiresAt: number }
  >();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly generateDataService: GenerateDataService,
    private readonly turboService: TurboService,
    private readonly deliveryOfferService: DeliveryOfferService,
    private readonly mapsService: MapsService,
  ) {}

  // ───────────────────────────── Réglages ─────────────────────────────

  async load(): Promise<IDeliveryFeeSettings> {
    const map = await this.settingsService.getMany([
      DELIVERY_FEE_SETTING_KEYS.turboZonesEnabled,
      DELIVERY_FEE_SETTING_KEYS.feeGrid,
      DELIVERY_FEE_SETTING_KEYS.defaultService,
      DELIVERY_FEE_SETTING_KEYS.serviceByRestaurant,
    ]);
    return {
      turboZonesEnabled: this.toBoolean(
        map[DELIVERY_FEE_SETTING_KEYS.turboZonesEnabled],
        DEFAULTS.turbo_zones_enabled,
      ),
      grid: this.toGrid(map[DELIVERY_FEE_SETTING_KEYS.feeGrid]),
      defaultService: this.toService(map[DELIVERY_FEE_SETTING_KEYS.defaultService]),
      serviceByRestaurant: this.toServiceMap(
        map[DELIVERY_FEE_SETTING_KEYS.serviceByRestaurant],
      ),
    };
  }

  /** Parse le service par défaut (réglage `delivery.default_service`) → enum valide, sinon TURBO. */
  private toService(raw?: string): DeliveryService {
    const v = raw?.trim();
    if (v && (Object.values(DeliveryService) as string[]).includes(v)) {
      return v as DeliveryService;
    }
    return DEFAULTS.default_service;
  }

  /** Parse `delivery.service_by_restaurant` (JSON { restaurantId: service }) — entrées invalides ignorées. */
  private toServiceMap(raw?: string): Record<string, DeliveryService> {
    if (!raw || raw.trim() === '') return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const valid = Object.values(DeliveryService) as string[];
      const out: Record<string, DeliveryService> = {};
      for (const [restaurantId, service] of Object.entries(parsed ?? {})) {
        if (typeof service === 'string' && valid.includes(service)) {
          out[restaurantId] = service as DeliveryService;
        }
      }
      return out;
    } catch {
      this.logger.warn('Réglage delivery.service_by_restaurant invalide (JSON attendu) — ignoré.');
      return {};
    }
  }

  /** Service applicable à UN restaurant : surcharge par restaurant sinon défaut global. */
  private serviceFor(
    feeSettings: IDeliveryFeeSettings,
    restaurantId?: string | null,
  ): DeliveryService {
    if (restaurantId && feeSettings.serviceByRestaurant[restaurantId]) {
      return feeSettings.serviceByRestaurant[restaurantId];
    }
    return feeSettings.defaultService;
  }

  /**
   * Livraison désactivée pour les commandes de l'APP (réglage temporaire
   * backoffice). Respecte `delivery.app_disabled_until` : passé cette date,
   * réactivation automatique. N'affecte QUE createv2 (app), jamais le call center.
   */
  async isAppDeliveryDisabled(): Promise<{ disabled: boolean; message: string }> {
    const map = await this.settingsService.getMany([
      'delivery.app_disabled',
      'delivery.app_disabled_until',
      'delivery.app_disabled_message',
    ]);
    if (!this.toBoolean(map['delivery.app_disabled'], 0)) {
      return { disabled: false, message: '' };
    }
    const untilRaw = map['delivery.app_disabled_until'];
    if (untilRaw && untilRaw.trim() !== '') {
      const until = new Date(untilRaw);
      if (!Number.isNaN(until.getTime()) && new Date() >= until) {
        // Période écoulée → livraison réactivée automatiquement.
        return { disabled: false, message: '' };
      }
    }
    const message =
      (map['delivery.app_disabled_message'] || '').trim() ||
      'La livraison est temporairement indisponible. Choisissez « À emporter » ou réessayez plus tard.';
    return { disabled: true, message };
  }

  /** Prix (FCFA) pour une distance (km) selon la grille. */
  priceForDistance(grid: IDeliveryFeeTier[], distanceKm: number): number {
    const sorted = this.sortGrid(grid);
    for (const tier of sorted) {
      const bound = tier.maxKm == null ? Number.POSITIVE_INFINITY : tier.maxKm;
      if (distanceKm <= bound) return tier.price;
    }
    return sorted.length ? sorted[sorted.length - 1].price : 5000;
  }

  /** Libellé informatif « a-b km de {resto} » / « +x km de {resto} ». */
  zoneLabel(
    grid: IDeliveryFeeTier[],
    distanceKm: number,
    restaurantName: string,
  ): string {
    const sorted = this.sortGrid(grid);
    let prev = 0;
    for (const tier of sorted) {
      if (tier.maxKm == null) break;
      if (distanceKm <= tier.maxKm) {
        return `${prev}-${tier.maxKm}km de ${restaurantName}`;
      }
      prev = tier.maxKm;
    }
    return `+${prev}km de ${restaurantName}`;
  }

  private sortGrid(grid: IDeliveryFeeTier[]): IDeliveryFeeTier[] {
    return [...grid].sort((a, b) => {
      const av = a.maxKm == null ? Number.POSITIVE_INFINITY : a.maxKm;
      const bv = b.maxKm == null ? Number.POSITIVE_INFINITY : b.maxKm;
      return av - bv;
    });
  }

  private toBoolean(raw: string | undefined, fallback: number): boolean {
    if (raw === undefined || raw === '') return fallback === 1;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'on' || v === 'yes';
  }

  private toGrid(raw: string | undefined): IDeliveryFeeTier[] {
    if (!raw || raw.trim() === '') return JSON.parse(DEFAULTS.fee_grid);
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('vide');
      const grid = parsed
        .map((t: { maxKm?: unknown; price?: unknown }) => ({
          maxKm:
            t.maxKm === null || t.maxKm === undefined || t.maxKm === ''
              ? null
              : Number(t.maxKm),
          price: Number(t.price) || 0,
        }))
        .filter(
          (t) => t.maxKm === null || (Number.isFinite(t.maxKm) && (t.maxKm as number) > 0),
        );
      if (grid.length === 0) throw new Error('vide après nettoyage');
      return grid;
    } catch {
      this.logger.warn('delivery.fee_grid invalide → grille par défaut utilisée');
      return JSON.parse(DEFAULTS.fee_grid);
    }
  }

  /** Facteur de détour du repli, borné à [1 ; 2] — hors de là, c'est une saisie fautive. */
  private async facteurDetour(): Promise<number> {
    const map = await this.settingsService.getMany([DELIVERY_FEE_SETTING_KEYS.facteurDetour]);
    const brut = Number(map[DELIVERY_FEE_SETTING_KEYS.facteurDetour]);
    if (!Number.isFinite(brut) || brut < 1 || brut > 2) return FACTEUR_DETOUR_DEFAUT;
    return brut;
  }

  /**
   * LA DISTANCE QUI SERT À FACTURER, en kilomètres.
   *
   * Par la route, comme ce que le client lit à l'écran. Tous nos affichages,
   * app comme backoffice, montrent l'itinéraire Google ; adosser les frais au
   * vol d'oiseau revenait à facturer une autre course que celle annoncée, et
   * l'écart penche toujours du même côté : 15,6 km par la route font environ
   * 12 km à vol d'oiseau, soit deux paliers plus bas. C'est ainsi qu'une
   * course de 22 km a pu se retrouver au tarif d'une course courte.
   *
   * ⚠️ Ce calcul est sur le chemin de création d'une commande. Il ne doit ni
   * la faire échouer, ni la faire attendre : l'appel est plafonné en temps et
   * ne lève jamais. Google muet ou lent → vol d'oiseau redressé du facteur de
   * détour, et une trace pour qu'un repli durable se voie.
   */
  private async distanceFacturableKm(
    restaurant: { name: string; latitude: number | null; longitude: number | null },
    lat: number,
    long: number,
  ): Promise<{ km: number; source: 'ROUTE' | 'VOL_OISEAU_CORRIGE' }> {
    const volOiseau = this.generateDataService.haversineDistance(
      restaurant.latitude ?? 0,
      restaurant.longitude ?? 0,
      lat,
      long,
    );

    // Restaurant sans coordonnées : le vol d'oiseau est déjà faux (il part de
    // 0,0), inutile de payer Google pour confirmer. Le verrou en aval fera le
    // reste.
    if (restaurant.latitude == null || restaurant.longitude == null) {
      return { km: volOiseau, source: 'VOL_OISEAU_CORRIGE' };
    }

    let metres: number | null = null;
    try {
      metres = await this.mapsService.distanceRoutiereMetres({
        originLat: restaurant.latitude,
        originLng: restaurant.longitude,
        destLat: lat,
        destLng: long,
      });
    } catch (err) {
      // `distanceRoutiereMetres` est censée ne jamais lever. Ce filet couvre le
      // jour où quelqu'un l'oublie : aucune commande ne doit tomber pour ça.
      this.logger.warn(
        `Distance routière en échec (${(err as Error).message}) — repli sur le vol d'oiseau.`,
      );
    }

    if (metres != null && Number.isFinite(metres) && metres > 0) {
      return { km: metres / 1000, source: 'ROUTE' };
    }

    const facteur = await this.facteurDetour();
    const corrige = volOiseau * facteur;
    this.logger.warn(
      `Distance routière indisponible pour ${restaurant.name} → ${lat},${long}. ` +
        `Repli : ${volOiseau.toFixed(1)} km à vol d'oiseau × ${facteur} = ${corrige.toFixed(1)} km facturés.`,
    );
    return { km: corrige, source: 'VOL_OISEAU_CORRIGE' };
  }

  // ──────────────────────────── Calcul du frais ────────────────────────────

  /** Frais via la grille interne distance→prix (réglage `delivery.fee_grid`). */
  async calculeFraisLivraisonPersonnalise({
    lat,
    long,
    restaurant,
  }: {
    lat: number;
    long: number;
    restaurant:
      | {
          name: string;
          id: string;
          latitude: number | null;
          longitude: number | null;
          schedule: JsonValue;
        }
      | undefined;
  }): Promise<DeliveryFeeResult> {
    if (!restaurant) {
      throw new BadRequestException('Aucun restaurant disponible');
    }

    const { km: distance, source } = await this.distanceFacturableKm(restaurant, lat, long);

    const feeSettings = await this.load();
    return {
      montant: this.priceForDistance(feeSettings.grid, distance),
      zone: this.zoneLabel(feeSettings.grid, distance, restaurant.name),
      distance: Math.round(distance),
      distance_exacte: distance,
      distance_source: source,
      service: this.serviceFor(feeSettings, restaurant.id),
      zone_id: null,
    };
  }

  /**
   * Frais de livraison : zones Turbo (si activées) sinon/secours grille interne.
   * C'est l'unique point d'entrée utilisé partout (app + création de commande).
   */
  async calculeFraisLivraison({
    lat,
    long,
    restaurant,
    channel,
    orderAmount,
    loyaltyLevel,
    customerId,
  }: {
    lat: number;
    long: number;
    restaurant:
      | {
          name: string;
          id: string;
          latitude: number | null;
          longitude: number | null;
          schedule: JsonValue;
          apikey: string | null;
        }
      | undefined;
    /** Contexte d'application des offres (offres ignorées si channel/orderAmount absent). */
    channel?: 'APP' | 'CALL_CENTER';
    orderAmount?: number;
    loyaltyLevel?: LoyaltyLevel | null;
    customerId?: string | null;
  }): Promise<DeliveryFeeResult> {
    if (!restaurant) {
      throw new BadRequestException('Aucun restaurant disponible');
    }

    // Frais via la grille interne (toujours calculé, sert aussi de secours).
    const config = await this.calculeFraisLivraisonPersonnalise({ lat, long, restaurant });

    let result: DeliveryFeeResult = config;

    // Zones Turbo (si activées) : remplace la grille par la zone la plus proche.
    const feeSettings = await this.load();
    if (feeSettings.turboZonesEnabled) {
      const memo = this.zonesTurboCache.get(restaurant.id);
      let zones: { id: string; name: string; latitude: number; longitude: number; prix: number }[];
      if (memo && memo.expiresAt > Date.now()) {
        zones = memo.zones;
      } else {
        const resultTurbo = await this.turboService.obtenirFraisLivraisonParRestaurant(
          restaurant.apikey ?? '',
          0,
          200,
        );
        zones = resultTurbo ? resultTurbo.content : [];
        this.zonesTurboCache.set(restaurant.id, { zones, expiresAt: Date.now() + 60_000 });
      }
      if (zones.length > 0) {
        const zone = zones.reduce((prev, current) => {
          const prevDistance = this.generateDataService.haversineDistance(
            prev.latitude,
            prev.longitude,
            lat,
            long,
          );
          const currentDistance = this.generateDataService.haversineDistance(
            current.latitude,
            current.longitude,
            lat,
            long,
          );
          return currentDistance < prevDistance ? current : prev;
        }, zones[0]);
        /**
         * ⚠️ VERROU 1 : une zone dont le prix n'est pas STRICTEMENT POSITIF
         * ne s'applique pas.
         *
         * Le prix vient de Turbo, pas de nous. Une zone à zéro, un champ
         * absent qui devient zéro, une réponse partielle : et toute livraison
         * rattachée à cette zone devient gratuite en silence. C'est la cause
         * de la commande à 22,6 km facturée « Gratuite ». La gratuité doit
         * être une décision, jamais un effet de bord.
         */
        const prixZone = Number(zone?.prix);
        if (!Number.isFinite(prixZone) || prixZone <= 0) {
          this.logger.error(
            `Zone Turbo « ${zone?.name} » du restaurant ${restaurant.name} : prix inexploitable (${zone?.prix}). Grille interne appliquée.`,
          );
        } else {
        result = {
          montant: prixZone,
          distance: config.distance,
          // La zone Turbo remplace le PRIX, pas la géographie : la distance
          // reste celle du restaurant au client.
          distance_exacte: config.distance_exacte,
          distance_source: config.distance_source,
          zone: restaurant.name + ' - ' + zone.name,
          service: this.serviceFor(feeSettings, restaurant.id),
          zone_id: zone.id,
        };
        }
      }
    }

    // Meilleure offre de livraison active (gratuite / % / fixe), si contexte fourni.
    if (channel && orderAmount != null) {
      const applicable = await this.deliveryOfferService.findApplicableOffer({
        baseFee: result.montant,
        // Les offres à prix imposé raisonnent par palier de distance. On leur
        // donne la distance EXACTE : l'arrondi au kilomètre ferait basculer de
        // palier une course sur deux, au détriment de la maison.
        distanceKm: result.distance_exacte ?? result.distance,
        restaurantId: restaurant.id,
        channel,
        orderAmount,
        loyaltyLevel,
        customerId: customerId ?? null,
      });
      if (applicable) {
        result = {
          ...result,
          montant: applicable.newFee,
          original_montant: result.montant,
          discount: applicable.discount,
          offer_id: applicable.offer.id,
          offer_name: applicable.offer.name,
        };
      }
    }

    /**
     * ⚠️ VERROU 2, le filet de sécurité : une livraison n'est JAMAIS gratuite
     * par accident.
     *
     * La gratuité est légitime dans un seul cas : une offre s'est appliquée.
     * C'est alors une décision commerciale assumée, quel que soit son type,
     * livraison offerte, remise de cent pour cent ou montant fixe supérieur au
     * tarif.
     *
     * Hors de ce cas, un frais nul ne peut venir que d'un défaut : zone au
     * prix absent, grille mal configurée, ou une cause qu'on n'a pas encore
     * vue. Ce verrou ne corrige pas une cause en particulier, il garantit
     * l'invariant, aujourd'hui et pour les défauts à venir.
     *
     * On retombe sur la grille interne, et à défaut sur la grille par défaut :
     * mieux vaut un tarif conservateur qu'une course offerte.
     */
    const offreAppliquee = result.offer_id != null;
    if (!offreAppliquee && (!Number.isFinite(result.montant) || result.montant <= 0)) {
      const secours =
        config.montant > 0
          ? config.montant
          : this.priceForDistance(DELIVERY_FEE_DEFAULT_GRID, config.distance_exacte ?? config.distance);
      this.logger.error(
        `FRAIS DE LIVRAISON NUL SANS OFFRE — restaurant ${restaurant.name}, ` +
          `${(config.distance_exacte ?? config.distance).toFixed(1)} km, zone « ${result.zone} ». ` +
          `Corrigé à ${secours} FCFA. A INVESTIGUER : une livraison gratuite doit venir d'une offre.`,
      );
      result = { ...result, montant: secours };
    }

    return result;
  }
}
