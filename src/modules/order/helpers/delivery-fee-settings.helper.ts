import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from 'src/modules/settings/settings.service';

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
 * Charge la configuration de calcul des frais de livraison depuis `settings`
 * (clé/valeur). Partagé par OrderHelper (endpoint /frais-livraison affiché par
 * l'app) ET OrderV2Helper (création de commande) → une seule source de vérité,
 * pas de divergence affichage↔débit. Pas de cache : effet immédiat après save.
 */
@Injectable()
export class DeliveryFeeSettingsHelper {
  private readonly logger = new Logger(DeliveryFeeSettingsHelper.name);

  constructor(private readonly settingsService: SettingsService) {}

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
}
