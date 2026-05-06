import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, BadGatewayException } from '@nestjs/common';
import type { Cache } from 'cache-manager';

// ─── Types partagés ──────────────────────────────────────────────────────────

export interface ILatLng {
  latitude: number;
  longitude: number;
}

export interface IDirectionsLeg {
  distanceMeters: number;
  durationSeconds: number;
  startCoord: ILatLng;
  endCoord: ILatLng;
}

export interface IDirectionsResult {
  coordinates: ILatLng[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  legs: IDirectionsLeg[];
}

export interface IReverseGeocodeResult {
  formattedAddress: string;
  components: Array<{ long_name: string; short_name: string; types: string[] }>;
}

export interface IAutocompleteResult {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface IPlaceDetailsResult {
  placeId: string;
  formattedAddress: string;
  name: string;
  latitude: number;
  longitude: number;
  addressComponents: Array<{ long_name: string; short_name: string; types: string[] }>;
}

// ─── TTLs (millisecondes) ────────────────────────────────────────────────────

const TTL = {
  DIRECTIONS:       10 * 60 * 1000,         //  10 min  — les routes peuvent changer
  REVERSE_GEOCODE:  24 * 60 * 60 * 1000,    //  24h     — l'adresse d'un point reste stable
  AUTOCOMPLETE:      5 * 60 * 1000,         //   5 min  — suggestions fraîches
  PLACE_DETAILS:     7 * 24 * 60 * 60 * 1000, // 7 jours — les détails d'un lieu sont immuables
} as const;

const BASE_URL = 'https://maps.googleapis.com/maps/api';

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly apiKey: string;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    this.apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
    if (!this.apiKey) {
      this.logger.warn('[Maps] GOOGLE_MAPS_API_KEY absent — les endpoints /maps/* seront non fonctionnels');
    }
  }

  // ── Utilitaires privés ───────────────────────────────────────────────────

  private key(prefix: string, ...parts: (string | number)[]): string {
    return `maps:${prefix}:${parts.join('_')}`;
  }

  private async googleFetch<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new BadGatewayException(`Google Maps API a répondu ${res.status}`);
    }
    const data = await res.json() as T;
    return data;
  }

  // ── Décodeur polyline Google Encoded ────────────────────────────────────

  private decodePolyline(encoded: string): ILatLng[] {
    const coords: ILatLng[] = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encoded.length) {
      let b: number;
      let shift = 0;
      let result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lng += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

      coords.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
    }
    return coords;
  }

  // ── Directions ───────────────────────────────────────────────────────────

  async getDirections(params: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    waypoints?: ILatLng[];
  }): Promise<IDirectionsResult | null> {
    const waypointsStr = params.waypoints?.map(w => `${w.latitude},${w.longitude}`).join('|') ?? '';
    const cacheKey = this.key(
      'directions',
      params.originLat.toFixed(5),
      params.originLng.toFixed(5),
      params.destLat.toFixed(5),
      params.destLng.toFixed(5),
      waypointsStr,
    );

    const cached = await this.cache.get<IDirectionsResult>(cacheKey);
    if (cached) {
      this.logger.debug(`[Maps] directions cache HIT ${cacheKey}`);
      return cached;
    }

    const url = new URL(`${BASE_URL}/directions/json`);
    url.searchParams.set('origin', `${params.originLat},${params.originLng}`);
    url.searchParams.set('destination', `${params.destLat},${params.destLng}`);
    if (waypointsStr) url.searchParams.set('waypoints', waypointsStr);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', this.apiKey);

    try {
      const data = await this.googleFetch<{
        status: string;
        routes?: {
          overview_polyline: { points: string };
          legs: {
            distance: { value: number };
            duration: { value: number };
            start_location: { lat: number; lng: number };
            end_location: { lat: number; lng: number };
          }[];
        }[];
      }>(url.toString());

      if (data.status !== 'OK' || !data.routes?.[0]) {
        this.logger.warn(`[Maps] Directions status=${data.status}`);
        return null;
      }

      const route = data.routes[0];
      const legs: IDirectionsLeg[] = route.legs.map((l) => ({
        distanceMeters: l.distance.value,
        durationSeconds: l.duration.value,
        startCoord: { latitude: l.start_location.lat, longitude: l.start_location.lng },
        endCoord: { latitude: l.end_location.lat, longitude: l.end_location.lng },
      }));

      const result: IDirectionsResult = {
        coordinates: this.decodePolyline(route.overview_polyline.points),
        totalDistanceMeters: legs.reduce((s, l) => s + l.distanceMeters, 0),
        totalDurationSeconds: legs.reduce((s, l) => s + l.durationSeconds, 0),
        legs,
      };

      await this.cache.set(cacheKey, result, TTL.DIRECTIONS);
      return result;
    } catch (err) {
      this.logger.warn(`[Maps] Directions error: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Reverse Geocode ──────────────────────────────────────────────────────

  async reverseGeocode(lat: number, lng: number): Promise<IReverseGeocodeResult | null> {
    const cacheKey = this.key('rev_geocode', lat.toFixed(4), lng.toFixed(4));

    const cached = await this.cache.get<IReverseGeocodeResult>(cacheKey);
    if (cached) {
      this.logger.debug(`[Maps] reverseGeocode cache HIT ${cacheKey}`);
      return cached;
    }

    const url = new URL(`${BASE_URL}/geocode/json`);
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('language', 'fr');
    url.searchParams.set('key', this.apiKey);

    try {
      const data = await this.googleFetch<{
        status: string;
        results?: { formatted_address: string; address_components: any[] }[];
      }>(url.toString());

      if (data.status !== 'OK' || !data.results?.[0]) {
        this.logger.warn(`[Maps] ReverseGeocode status=${data.status}`);
        return null;
      }

      // Filtrer les résultats Plus Code (ex: "XCW9+V2 Abidjan")
      const best = data.results.find(
        (r) => !r.formatted_address.match(/[A-Z0-9]{4}\+[A-Z0-9]{2}/),
      ) ?? data.results[0];

      const result: IReverseGeocodeResult = {
        formattedAddress: best.formatted_address,
        components: best.address_components,
      };

      await this.cache.set(cacheKey, result, TTL.REVERSE_GEOCODE);
      return result;
    } catch (err) {
      this.logger.warn(`[Maps] ReverseGeocode error: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Places Autocomplete ──────────────────────────────────────────────────

  async placesAutocomplete(params: {
    input: string;
    components?: string;
    language?: string;
    sessionToken?: string;
  }): Promise<IAutocompleteResult[]> {
    const cacheKey = this.key(
      'places_ac',
      encodeURIComponent(params.input.toLowerCase()),
      params.components ?? 'ci',
    );

    const cached = await this.cache.get<IAutocompleteResult[]>(cacheKey);
    if (cached) {
      this.logger.debug(`[Maps] autocomplete cache HIT "${params.input}"`);
      return cached;
    }

    const url = new URL(`${BASE_URL}/place/autocomplete/json`);
    url.searchParams.set('input', params.input);
    url.searchParams.set('language', params.language ?? 'fr');
    url.searchParams.set('key', this.apiKey);
    if (params.components) url.searchParams.set('components', params.components);
    if (params.sessionToken) url.searchParams.set('sessiontoken', params.sessionToken);

    try {
      const data = await this.googleFetch<{
        status: string;
        predictions?: {
          place_id: string;
          description: string;
          structured_formatting: {
            main_text: string;
            secondary_text?: string;
          };
        }[];
      }>(url.toString());

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        this.logger.warn(`[Maps] Autocomplete status=${data.status}`);
      }

      const results: IAutocompleteResult[] = (data.predictions ?? []).map((p) => ({
        placeId: p.place_id,
        description: p.description,
        mainText: p.structured_formatting.main_text,
        secondaryText: p.structured_formatting.secondary_text ?? '',
      }));

      await this.cache.set(cacheKey, results, TTL.AUTOCOMPLETE);
      return results;
    } catch (err) {
      this.logger.warn(`[Maps] Autocomplete error: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Place Details ────────────────────────────────────────────────────────

  async placeDetails(placeId: string, sessionToken?: string): Promise<IPlaceDetailsResult | null> {
    const cacheKey = this.key('place_det', placeId);

    const cached = await this.cache.get<IPlaceDetailsResult>(cacheKey);
    if (cached) {
      this.logger.debug(`[Maps] placeDetails cache HIT ${placeId}`);
      return cached;
    }

    const url = new URL(`${BASE_URL}/place/details/json`);
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'geometry,formatted_address,name,address_components');
    url.searchParams.set('language', 'fr');
    url.searchParams.set('key', this.apiKey);
    if (sessionToken) url.searchParams.set('sessiontoken', sessionToken);

    try {
      const data = await this.googleFetch<{
        status: string;
        result?: {
          place_id: string;
          name: string;
          formatted_address: string;
          geometry: { location: { lat: number; lng: number } };
          address_components: any[];
        };
      }>(url.toString());

      if (data.status !== 'OK' || !data.result) {
        this.logger.warn(`[Maps] PlaceDetails status=${data.status}`);
        return null;
      }

      const r = data.result;
      const result: IPlaceDetailsResult = {
        placeId: r.place_id ?? placeId,
        formattedAddress: r.formatted_address,
        name: r.name,
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
        addressComponents: r.address_components,
      };

      await this.cache.set(cacheKey, result, TTL.PLACE_DETAILS);
      return result;
    } catch (err) {
      this.logger.warn(`[Maps] PlaceDetails error: ${(err as Error).message}`);
      return null;
    }
  }
}
