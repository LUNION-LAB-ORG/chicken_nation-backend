import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DeliveryService } from '@prisma/client';
import { JsonValue } from '@prisma/client/runtime/library';
import { SettingsService } from 'src/modules/settings/settings.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { TurboService } from 'src/turbo/services/turbo.service';

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
}

/** Résultat d'un calcul de frais de livraison. */
export interface DeliveryFeeResult {
  montant: number;
  zone: string;
  distance: number;
  service: DeliveryService;
  zone_id: string | null;
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
};

/** Clés `settings` (préfixe `delivery.`). */
export const DELIVERY_FEE_SETTING_KEYS = {
  turboZonesEnabled: 'delivery.turbo_zones_enabled',
  feeGrid: 'delivery.fee_grid',
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
  ) {}

  // ───────────────────────────── Réglages ─────────────────────────────

  async load(): Promise<IDeliveryFeeSettings> {
    const map = await this.settingsService.getMany([
      DELIVERY_FEE_SETTING_KEYS.turboZonesEnabled,
      DELIVERY_FEE_SETTING_KEYS.feeGrid,
    ]);
    return {
      turboZonesEnabled: this.toBoolean(
        map[DELIVERY_FEE_SETTING_KEYS.turboZonesEnabled],
        DEFAULTS.turbo_zones_enabled,
      ),
      grid: this.toGrid(map[DELIVERY_FEE_SETTING_KEYS.feeGrid]),
    };
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
      service: DeliveryService.TURBO,
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
  }): Promise<DeliveryFeeResult> {
    if (!restaurant) {
      throw new BadRequestException('Aucun restaurant disponible');
    }

    // Frais via la grille interne (toujours calculé, sert aussi de secours).
    const config = await this.calculeFraisLivraisonPersonnalise({ lat, long, restaurant });

    // Zones Turbo désactivées via les réglages → on garde la grille interne.
    const feeSettings = await this.load();
    if (!feeSettings.turboZonesEnabled) {
      return config;
    }

    // Récupérer les zones de livraison de Turbo.
    const resultTurbo = await this.turboService.obtenirFraisLivraisonParRestaurant(
      restaurant.apikey ?? '',
      0,
      200,
    );
    const zones = resultTurbo ? resultTurbo.content : [];

    if (zones.length === 0) {
      return config;
    }

    // Zone Turbo la plus proche (centre de zone le plus proche du client).
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

    return {
      montant: zone.prix,
      distance: config.distance,
      zone: restaurant.name + ' - ' + zone.name,
      service: DeliveryService.TURBO,
      zone_id: zone.id,
    };
  }
}
