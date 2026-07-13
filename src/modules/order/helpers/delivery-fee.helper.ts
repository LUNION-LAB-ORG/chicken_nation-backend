import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DeliveryService, LoyaltyLevel } from '@prisma/client';
import { JsonValue } from '@prisma/client/runtime/library';
import { SettingsService } from 'src/modules/settings/settings.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { TurboService } from 'src/turbo/services/turbo.service';
import { DeliveryOfferService } from 'src/modules/delivery-offer/services/delivery-offer.service';

/**
 * Un palier de la grille de frais de livraison : tout trajet dont la distance
 * (km, à vol d'oiseau) est <= `maxKm` est facturé `price`. `maxKm: null` = palier
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
}

/** Résultat d'un calcul de frais de livraison. */
export interface DeliveryFeeResult {
  montant: number;
  zone: string;
  distance: number;
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

  constructor(
    private readonly settingsService: SettingsService,
    private readonly generateDataService: GenerateDataService,
    private readonly turboService: TurboService,
    private readonly deliveryOfferService: DeliveryOfferService,
  ) {}

  // ───────────────────────────── Réglages ─────────────────────────────

  async load(): Promise<IDeliveryFeeSettings> {
    const map = await this.settingsService.getMany([
      DELIVERY_FEE_SETTING_KEYS.turboZonesEnabled,
      DELIVERY_FEE_SETTING_KEYS.feeGrid,
      DELIVERY_FEE_SETTING_KEYS.defaultService,
    ]);
    return {
      turboZonesEnabled: this.toBoolean(
        map[DELIVERY_FEE_SETTING_KEYS.turboZonesEnabled],
        DEFAULTS.turbo_zones_enabled,
      ),
      grid: this.toGrid(map[DELIVERY_FEE_SETTING_KEYS.feeGrid]),
      defaultService: this.toService(map[DELIVERY_FEE_SETTING_KEYS.defaultService]),
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

    const distance = this.generateDataService.haversineDistance(
      restaurant.latitude ?? 0,
      restaurant.longitude ?? 0,
      lat,
      long,
    );

    const feeSettings = await this.load();
    return {
      montant: this.priceForDistance(feeSettings.grid, distance),
      zone: this.zoneLabel(feeSettings.grid, distance, restaurant.name),
      distance: Math.round(distance),
      service: feeSettings.defaultService,
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
      const resultTurbo = await this.turboService.obtenirFraisLivraisonParRestaurant(
        restaurant.apikey ?? '',
        0,
        200,
      );
      const zones = resultTurbo ? resultTurbo.content : [];
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
        result = {
          montant: zone.prix,
          distance: config.distance,
          zone: restaurant.name + ' - ' + zone.name,
          service: feeSettings.defaultService,
          zone_id: zone.id,
        };
      }
    }

    // Meilleure offre de livraison active (gratuite / % / fixe), si contexte fourni.
    if (channel && orderAmount != null) {
      const applicable = await this.deliveryOfferService.findApplicableOffer({
        baseFee: result.montant,
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

    return result;
  }
}
