import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { racinePublique, urlApi } from 'src/common/utils/url-publique.util';
import { Inject, Injectable, Logger, BadGatewayException } from '@nestjs/common';
import type { Cache } from 'cache-manager';

import { CompteurAppelsGoogleService } from './compteur-appels-google.service';

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
  /** Temps de CONDUITE seul, trafic compris. */
  totalDurationSeconds: number;
  /**
   * Durée RÉELLE de la mission : conduite + arrêts chez chaque client
   * intermédiaire. C'est la valeur à montrer sur une course groupée, où
   * plusieurs remises s'enchaînent.
   */
  totalDurationWithStopsSeconds: number;
  /** Part des arrêts dans la durée ci-dessus. */
  stopsSeconds: number;
  legs: IDirectionsLeg[];
}

/**
 * Itinéraire routier SANS trafic entre deux points fixes : distance, durée et
 * tracé, tirés d'UNE réponse Directions et gardés ensemble 30 jours.
 */
export interface IItineraireRoutier {
  /** Mètres par la route. */
  metres: number;
  /** Secondes de conduite sans trafic (0 si Google ne les a pas données). */
  secondes: number;
  /** Tracé au format « Encoded Polyline » de Google (`overview_polyline`), vide s'il manque. */
  polyligne: string;
}

/** Durées sans trafic du trajet direct R → L et du même trajet avec l'étape P. */
export interface IMesureDetour {
  secondesDirect: number;
  secondesAvecEtape: number;
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
  /** Nature du lieu selon Google : `route`, `premise`, `sublocality`, `locality`... */
  types: string[];
  /** Emprise que Google juge representative du lieu. Absente sur certains lieux. */
  viewport: {
    northeast: { lat: number; lng: number };
    southwest: { lat: number; lng: number };
  } | null;
}

// ─── TTLs (millisecondes) ────────────────────────────────────────────────────

const TTL = {
  // 3 min (et non 10) : la durée est calculée AVEC le trafic temps réel. La
  // mettre en cache trop longtemps reviendrait à servir un temps périmé, ce qui
  // annulerait l'intérêt de la demander. Compromis entre fraîcheur et coût.
  DIRECTIONS:        3 * 60 * 1000,         //   3 min  — durée avec trafic, doit rester fraîche
  // 30 jours. La distance ROUTIÈRE entre deux points fixes ne bouge pas d'un
  // jour à l'autre : contrairement à la durée, elle ne dépend pas du trafic.
  // Un cache long est ici gratuit en fraîcheur et décisif sur la facture
  // Google, puisque cet appel est sur le chemin de CHAQUE commande livrée.
  ROAD_DISTANCE:    30 * 24 * 60 * 60 * 1000, // 30 jours — la route entre deux points est stable
  REVERSE_GEOCODE:  24 * 60 * 60 * 1000,    //  24h     — l'adresse d'un point reste stable
  AUTOCOMPLETE:      5 * 60 * 1000,         //   5 min  — suggestions fraîches
  PLACE_DETAILS:     7 * 24 * 60 * 60 * 1000, // 7 jours — les détails d'un lieu sont immuables
  // 12h et non 7 jours : une vignette dépend de choses qui peuvent casser (nos
  // pastilles, notre URL publique). Une image dégradée figée une semaine, c'est
  // la panne multipliée par la durée du cache.
  STATIC_ROUTE:     12 * 60 * 60 * 1000,    //  12h     — image d'itinéraire
} as const;

/** Adresse de l'API Google Maps en production. */
export const GOOGLE_MAPS_API_PRODUCTION = 'https://maps.googleapis.com/maps/api';

/**
 * Adresse de l'API Google Maps : `GOOGLE_MAPS_API_URL` si l'environnement la
 * donne, sinon Google. Le banc local la pointe vers une adresse fermée
 * (127.0.0.1:9) : aucune requête ne part chez Google, et la distance retombe
 * sur le vol d'oiseau, repli déjà prévu quand Google ne répond pas.
 */
export function adresseGoogleMaps(env: Record<string, string | undefined> = process.env): string {
  const reglee = env.GOOGLE_MAPS_API_URL?.trim().replace(/\/+$/, '');
  return reglee || GOOGLE_MAPS_API_PRODUCTION;
}

const BASE_URL = adresseGoogleMaps();

/**
 * Temps passé chez un client avant de repartir : trouver la porte, remettre la
 * commande, faire saisir le code. Google ne compte QUE la conduite, or sur une
 * course groupée ces arrêts s'additionnent et pèsent lourd dans l'estimation.
 * Ajustable via `MAPS_STOP_SECONDS`.
 */
const STOP_SECONDS_PER_DELIVERY = Number(process.env.MAPS_STOP_SECONDS ?? 180);

/**
 * Plafond d'attente de Google pour la distance de FACTURATION. Court par
 * construction : cet appel se produit pendant qu'un client attend la
 * validation de sa commande. Passé ce délai on facture au vol d'oiseau
 * corrigé plutôt que de faire patienter. Ajustable via
 * `MAPS_ROAD_DISTANCE_TIMEOUT_MS`.
 */
const ROAD_DISTANCE_TIMEOUT_MS = Number(process.env.MAPS_ROAD_DISTANCE_TIMEOUT_MS ?? 2500);

/**
 * Plafond d'attente des autres appels du dispatch et des trajets affichés
 * (`getDirections`, `getTravelTimes`, détour) : 2,5 s. Sans lui, un Google
 * muet bloquait le choix d'un livreur jusqu'aux délais par défaut de Node,
 * soit plusieurs minutes. Ajustable via `MAPS_GOOGLE_TIMEOUT_MS`.
 */
function delaiGoogleMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MAPS_GOOGLE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}
const GOOGLE_TIMEOUT_MS = delaiGoogleMs();

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly apiKey: string;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    // Compteur par fonction et par jour, et plafond quotidien des appels qui
    // ont un repli sans Google (maps.plafond_appels_jour).
    private readonly compteur: CompteurAppelsGoogleService,
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

  /**
   * `timeoutMs` : plafond d'attente. Sans lui, un Google qui ne répond pas
   * laisse l'appel pendre jusqu'aux délais par défaut de Node, soit plusieurs
   * minutes. Acceptable pour un écran de carte, inacceptable sur le chemin de
   * création d'une commande. Les appelants historiques n'en passent pas et
   * gardent exactement leur comportement.
   */
  private async googleFetch<T>(url: string, timeoutMs?: number): Promise<T> {
    const controleur = timeoutMs ? new AbortController() : undefined;
    const minuterie = controleur
      ? setTimeout(() => controleur.abort(), timeoutMs)
      : undefined;
    try {
      const res = await fetch(url, controleur ? { signal: controleur.signal } : undefined);
      if (!res.ok) {
        throw new BadGatewayException(`Google Maps API a répondu ${res.status}`);
      }
      const data = await res.json() as T;
      return data;
    } finally {
      if (minuterie) clearTimeout(minuterie);
    }
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
    // TRAFIC TEMPS RÉEL. Sans `departure_time`, Google renvoie une durée
    // THÉORIQUE calculée sur les limitations de vitesse : à Abidjan, un trajet
    // annoncé 12 min en prend 25 aux heures de pointe, et le livreur comme le
    // client se fient à un chiffre faux. Avec ces deux paramètres, la réponse
    // porte `duration_in_traffic`.
    // ⚠️ Cet appel est facturé au tarif Directions Advanced (plus cher) : le
    // cache court ci-dessus est ce qui garde la facture raisonnable.
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('traffic_model', 'best_guess');
    url.searchParams.set('key', this.apiKey);

    // Compté, jamais plafonné : c'est le trajet affiché au livreur et au client.
    this.compteur.compter('trajet_trafic');
    try {
      const data = await this.googleFetch<{
        status: string;
        routes?: {
          overview_polyline: { points: string };
          legs: {
            distance: { value: number };
            duration: { value: number };
            /** Présent uniquement si `departure_time` a été transmis. */
            duration_in_traffic?: { value: number };
            start_location: { lat: number; lng: number };
            end_location: { lat: number; lng: number };
          }[];
        }[];
      }>(url.toString(), GOOGLE_TIMEOUT_MS);

      if (data.status !== 'OK' || !data.routes?.[0]) {
        this.logger.warn(`[Maps] Directions status=${data.status}`);
        return null;
      }

      const route = data.routes[0];
      // `duration_in_traffic` quand Google le fournit (trafic temps réel),
      // sinon repli sur la durée théorique : jamais de valeur manquante.
      const legs: IDirectionsLeg[] = route.legs.map((l) => ({
        distanceMeters: l.distance.value,
        durationSeconds: l.duration_in_traffic?.value ?? l.duration.value,
        startCoord: { latitude: l.start_location.lat, longitude: l.start_location.lng },
        endCoord: { latitude: l.end_location.lat, longitude: l.end_location.lng },
      }));

      // ARRÊTS INTERMÉDIAIRES (courses groupées). Google ne compte QUE le temps
      // de conduite. Sur une tournée à plusieurs livraisons, le livreur s'arrête
      // à chaque client : trouver la porte, remettre les plats, saisir le code.
      // Ignorer ces arrêts sous-estime lourdement une course chaînée (une
      // tournée de 3 clients perd environ 6 minutes dans l'estimation).
      // Le dernier client n'ouvre pas d'arrêt : on n'en compte que N-1.
      const arrets = Math.max(0, legs.length - 1);
      const tempsArretsSeconds = arrets * STOP_SECONDS_PER_DELIVERY;
      const conduiteSeconds = legs.reduce((s, l) => s + l.durationSeconds, 0);

      const result: IDirectionsResult = {
        coordinates: this.decodePolyline(route.overview_polyline.points),
        totalDistanceMeters: legs.reduce((s, l) => s + l.distanceMeters, 0),
        // Conduite seule — conservé tel quel pour ne rien casser des usages existants.
        totalDurationSeconds: conduiteSeconds,
        // Durée RÉELLE de la mission, arrêts compris : c'est celle à présenter
        // au livreur pour qu'il décide, et au client pour son heure d'arrivée.
        totalDurationWithStopsSeconds: conduiteSeconds + tempsArretsSeconds,
        stopsSeconds: tempsArretsSeconds,
        legs,
      };

      await this.cache.set(cacheKey, result, TTL.DIRECTIONS);
      return result;
    } catch (err) {
      this.logger.warn(`[Maps] Directions error: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Distance routière et tracé (facturation, acheminement, direction) ──

  /** Clé de cache d'un trajet entre deux points arrondis à 4 décimales (≈ 11 m). */
  private cleTrajet(prefixe: string, ...points: { lat: number; lng: number }[]): string {
    return this.key(prefixe, ...points.flatMap((p) => [p.lat.toFixed(4), p.lng.toFixed(4)]));
  }

  /** Lecture du cache qui ne lève jamais (Redis coupé = absent). */
  private async lireCache<T>(cle: string): Promise<T | undefined> {
    try {
      return (await this.cache.get<T>(cle)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async ecrireCache(cle: string, valeur: unknown, ttl: number): Promise<void> {
    try {
      await this.cache.set(cle, valeur, ttl);
    } catch (err) {
      this.logger.warn(`[Maps] Cache indisponible : ${(err as Error).message}`);
    }
  }

  /** Itinéraire routier déjà en cache, sans jamais appeler Google. */
  private async itineraireEnCache(cle: string): Promise<IItineraireRoutier | null> {
    let brut: unknown = await this.lireCache<unknown>(cle);
    if (typeof brut === 'string') {
      try {
        brut = JSON.parse(brut);
      } catch {
        return null;
      }
    }
    const v = brut as Partial<IItineraireRoutier> | null | undefined;
    const metres = Number(v?.metres);
    if (!v || !Number.isFinite(metres) || metres <= 0) return null;
    const secondes = Number(v.secondes);
    return {
      metres,
      secondes: Number.isFinite(secondes) && secondes > 0 ? secondes : 0,
      polyligne: typeof v.polyligne === 'string' ? v.polyligne : '',
    };
  }

  /**
   * Itinéraire PAR LA ROUTE entre deux points fixes, SANS trafic : mètres,
   * secondes de conduite et tracé (`overview_polyline`), tirés d'une seule
   * réponse Directions et gardés ensemble 30 jours.
   *
   * C'est l'appel déjà payé pour les frais de livraison, dont le tracé était
   * jeté : il sert désormais aussi à la règle « même direction » (un client
   * est-il sur la route d'un autre ?) sans aucun appel de plus.
   *
   * Pas de `departure_time` (tarif de base) : la distance et le tracé ne
   * dépendent pas du trafic. Ne lève jamais : `null` si la clé manque, si
   * Google n'a pas répondu dans les 2,5 s, s'il n'y a pas d'itinéraire, ou
   * si le plafond quotidien d'appels est atteint (repli sans Google).
   */
  async itineraireRoutier(params: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
  }): Promise<IItineraireRoutier | null> {
    const origine = { lat: params.originLat, lng: params.originLng };
    const destination = { lat: params.destLat, lng: params.destLng };
    if (![origine.lat, origine.lng, destination.lat, destination.lng].every(Number.isFinite)) return null;

    const cacheKey = this.cleTrajet('road-route', origine, destination);
    const enCache = await this.itineraireEnCache(cacheKey);
    if (enCache) return enCache;

    if (!this.apiKey) return null;
    if (!(await this.compteur.reserver('itineraire'))) return null;

    const url = new URL(`${BASE_URL}/directions/json`);
    url.searchParams.set('origin', `${params.originLat},${params.originLng}`);
    url.searchParams.set('destination', `${params.destLat},${params.destLng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', this.apiKey);

    try {
      const data = await this.googleFetch<{
        status: string;
        routes?: {
          overview_polyline?: { points?: string };
          legs: { distance?: { value: number }; duration?: { value: number } }[];
        }[];
      }>(url.toString(), ROAD_DISTANCE_TIMEOUT_MS);

      if (data.status !== 'OK' || !data.routes?.[0]?.legs?.length) {
        this.logger.warn(`[Maps] Distance routière indisponible (status=${data.status})`);
        return null;
      }

      const route = data.routes[0];
      const metres = route.legs.reduce((somme, l) => somme + (l.distance?.value ?? 0), 0);
      if (!Number.isFinite(metres) || metres <= 0) {
        this.logger.warn('[Maps] Distance routière renvoyée nulle ou invalide.');
        return null;
      }
      const secondes = route.legs.reduce((somme, l) => somme + (l.duration?.value ?? 0), 0);

      const itineraire: IItineraireRoutier = {
        metres,
        secondes: Number.isFinite(secondes) && secondes > 0 ? secondes : 0,
        polyligne: route.overview_polyline?.points ?? '',
      };
      await this.ecrireCache(cacheKey, itineraire, TTL.ROAD_DISTANCE);
      return itineraire;
    } catch (err) {
      this.logger.warn(`[Maps] Distance routière en échec : ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Distance PAR LA ROUTE entre deux points, en mètres. Destinée au CALCUL DES
   * FRAIS DE LIVRAISON, et distincte de `getDirections` à dessein.
   *
   * `getDirections` transporte le trafic temps réel : il est facturé au tarif
   * Directions Advanced et ne peut être mis en cache que quelques minutes,
   * sans quoi il servirait une durée périmée. Facturer n'a besoin que d'une
   * distance, qui elle ne dépend pas du trafic et ne change pas d'un jour à
   * l'autre entre deux points fixes. D'où, ici : pas de `departure_time`
   * (tarif de base) et un cache de 30 jours. Une adresse enregistrée n'est
   * donc payée à Google qu'une fois par mois, quel que soit le nombre de
   * commandes qu'elle reçoit.
   *
   * S'appuie sur `itineraireRoutier` (mêmes mètres, tracé gardé en plus).
   * L'ancienne entrée de cache (mètres seuls) est encore lue pendant ses
   * 30 jours : une adresse déjà payée ne l'est pas une seconde fois pour les
   * frais ; son tracé sera demandé au premier besoin de la règle de direction.
   *
   * Ne lève jamais : renvoie `null` si la clé manque, si Google n'a pas
   * répondu dans le délai imparti, s'il n'existe pas d'itinéraire, ou si le
   * plafond quotidien est atteint. Cet appel est sur le chemin de création
   * d'une commande : il doit pouvoir échouer sans la faire échouer.
   */
  async distanceRoutiereMetres(params: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
  }): Promise<number | null> {
    const origine = { lat: params.originLat, lng: params.originLng };
    const destination = { lat: params.destLat, lng: params.destLng };
    if (![origine.lat, origine.lng, destination.lat, destination.lng].every(Number.isFinite)) return null;

    const enCache = await this.itineraireEnCache(this.cleTrajet('road-route', origine, destination));
    if (enCache) return enCache.metres;

    // `Number(...)` et non un test de type : selon le store, un nombre peut
    // revenir sérialisé en chaîne. Une valeur absente donne NaN ou 0 et
    // retombe naturellement sur l'appel.
    const ancienne = Number(await this.lireCache<number>(this.cleTrajet('road-distance', origine, destination)));
    if (Number.isFinite(ancienne) && ancienne > 0) return ancienne;

    return (await this.itineraireRoutier(params))?.metres ?? null;
  }

  /**
   * Détour réel imposé par une étape, SANS trafic : durée du trajet direct
   * restaurant → client lointain, et du même trajet en passant par le client
   * proche. Sert au test 5 de la règle « même direction ».
   *
   * Les deux durées viennent de Google sans trafic (le trajet direct est celui
   * d'`itineraireRoutier`, presque toujours en cache) : jamais de mélange avec
   * une estimation. Cache 30 jours (points arrondis à 4 décimales), délai
   * 2,5 s, plafond quotidien. Ne lève jamais : `null` = repli sans carte.
   */
  async detourSansTrafic(params: {
    restaurant: ILatLng;
    proche: ILatLng;
    lointain: ILatLng;
  }): Promise<IMesureDetour | null> {
    const r = { lat: params.restaurant.latitude, lng: params.restaurant.longitude };
    const p = { lat: params.proche.latitude, lng: params.proche.longitude };
    const l = { lat: params.lointain.latitude, lng: params.lointain.longitude };
    if (![r, p, l].every((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng))) return null;

    const direct = await this.itineraireRoutier({
      originLat: r.lat,
      originLng: r.lng,
      destLat: l.lat,
      destLng: l.lng,
    });
    if (!direct || direct.secondes <= 0) return null;

    const cacheKey = this.cleTrajet('detour', r, p, l);
    const enCache = Number(await this.lireCache<number>(cacheKey));
    if (Number.isFinite(enCache) && enCache > 0) {
      return { secondesDirect: direct.secondes, secondesAvecEtape: enCache };
    }

    if (!this.apiKey) return null;
    if (!(await this.compteur.reserver('detour'))) return null;

    const url = new URL(`${BASE_URL}/directions/json`);
    url.searchParams.set('origin', `${r.lat},${r.lng}`);
    url.searchParams.set('destination', `${l.lat},${l.lng}`);
    url.searchParams.set('waypoints', `${p.lat},${p.lng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', this.apiKey);

    try {
      const data = await this.googleFetch<{
        status: string;
        routes?: { legs: { duration?: { value: number } }[] }[];
      }>(url.toString(), GOOGLE_TIMEOUT_MS);

      if (data.status !== 'OK' || !data.routes?.[0]?.legs?.length) {
        this.logger.warn(`[Maps] Détour indisponible (status=${data.status})`);
        return null;
      }
      const avecEtape = data.routes[0].legs.reduce((somme, leg) => somme + (leg.duration?.value ?? 0), 0);
      if (!Number.isFinite(avecEtape) || avecEtape <= 0) return null;

      await this.ecrireCache(cacheKey, avecEtape, TTL.ROAD_DISTANCE);
      return { secondesDirect: direct.secondes, secondesAvecEtape: avecEtape };
    } catch (err) {
      this.logger.warn(`[Maps] Détour en échec : ${(err as Error).message}`);
      return null;
    }
  }

  // ── Temps de trajet (Distance Matrix) ────────────────────────────────────

  /**
   * Temps de trajet RÉELS de plusieurs origines vers une destination unique,
   * trafic compris. Un seul appel pour tout le lot.
   *
   * Sert au choix du livreur : la distance à vol d'oiseau ment dès qu'il y a un
   * pont, un sens unique ou une lagune. Un livreur à 800 m de l'autre côté d'un
   * pont est plus loin qu'un livreur à 1,5 km en ligne droite.
   *
   * Renvoie un tableau aligné sur `origins` ; `null` pour une origine dont
   * Google n'a pas su calculer l'itinéraire. Renvoie `null` global en cas
   * d'échec, de délai dépassé (2,5 s) ou de plafond quotidien atteint, pour
   * que l'appelant retombe sur son classement habituel. Les positions
   * périmées sont écartées par l'appelant (`DelivererScoringService`).
   */
  async getTravelTimes(
    origins: ILatLng[],
    destination: ILatLng,
  ): Promise<(number | null)[] | null> {
    if (origins.length === 0) return [];

    const originsStr = origins.map((o) => `${o.latitude},${o.longitude}`).join('|');
    const destStr = `${destination.latitude},${destination.longitude}`;
    const cacheKey = this.key('matrix', originsStr, destStr);

    const cached = await this.cache.get<(number | null)[]>(cacheKey);
    if (cached) return cached;

    if (!this.apiKey) return null;
    if (!(await this.compteur.reserver('temps_trajet'))) return null;

    const url = new URL(`${BASE_URL}/distancematrix/json`);
    url.searchParams.set('origins', originsStr);
    url.searchParams.set('destinations', destStr);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('traffic_model', 'best_guess');
    url.searchParams.set('key', this.apiKey);

    try {
      const data = await this.googleFetch<{
        status: string;
        rows?: {
          elements: {
            status: string;
            duration?: { value: number };
            duration_in_traffic?: { value: number };
          }[];
        }[];
      }>(url.toString(), GOOGLE_TIMEOUT_MS);

      if (data.status !== 'OK' || !data.rows) {
        this.logger.warn(`[Maps] DistanceMatrix status=${data.status}`);
        return null;
      }

      const result = data.rows.map((row) => {
        const el = row.elements?.[0];
        if (!el || el.status !== 'OK') return null;
        return el.duration_in_traffic?.value ?? el.duration?.value ?? null;
      });

      await this.cache.set(cacheKey, result, TTL.DIRECTIONS);
      return result;
    } catch (err) {
      this.logger.warn(`[Maps] DistanceMatrix error: ${(err as Error).message}`);
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

    this.compteur.compter('geocodage_inverse');
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

    this.compteur.compter('saisie_adresse');
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

  /**
   * Style de la vignette d'itinéraire : une carte CALME.
   *
   * Par défaut Google couvre le quartier de pastilles de commerces, et sur
   * Abidjan cela donne une dizaine de restaurants, hôtels et cafés autour du
   * trajet. Le client ne cherche pas un café, il cherche à reconnaître sa rue :
   * tout ce qui n'aide pas à ça lui vole l'attention et cache le tracé.
   *
   * On coupe donc les points d'intérêt et les transports, on garde les rues et
   * leurs noms, qui sont le seul repère utile, et on désature le fond pour que
   * l'orange du trajet et les deux marqueurs soient la seule chose vive.
   */
  /** Évite de répéter l'avertissement `BASE_URL` à chaque vignette. */
  private static baseUrlSignalee = false;

  private static readonly STYLE_VIGNETTE = [
    'feature:poi|visibility:off',
    'feature:transit|visibility:off',
    // Les parcs restent visibles, sans étiquette : ce sont de vrais repères.
    'feature:poi.park|element:geometry|visibility:on|color:0xe7eee2',
    'feature:landscape|color:0xf6f4f1',
    'feature:water|color:0xdbe8f2',
    'feature:road|element:geometry|color:0xffffff',
    'feature:road.highway|element:geometry|color:0xf2ede6',
    'feature:road|element:geometry.stroke|color:0xe9e5df',
    'feature:road|element:labels.icon|visibility:off',
    'feature:road|element:labels.text.fill|color:0x9ca3af',
    'feature:road|element:labels.text.stroke|color:0xffffff',
    'feature:administrative|element:geometry|visibility:off',
    'feature:administrative.locality|element:labels.text.fill|color:0x9ca3af',
  ];

  // ── Vignette d'itinéraire (Static Maps) ─────────────────────────────────

  /**
   * Image PNG du trajet restaurant → client, pour l'aperçu du panier.
   *
   * Une carte NATIVE ne convient pas à cet emplacement : elle vit dans un
   * défilement, et sur iOS une seconde `MKMapView` montée pendant la fermeture
   * d'un modal fait tomber l'application (`AIRMapManager`, SIGSEGV). Une image
   * n'a aucun de ces défauts et suffit largement pour vérifier un trajet.
   *
   * L'image est fabriquée ICI pour que la clé Google ne quitte jamais le
   * serveur : l'application reçoit des octets, pas une URL signée.
   */
  async staticRoute(params: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    width: number;
    height: number;
    scale: number;
    /**
     * Part HAUTE de l'image à laisser libre, entre 0 et 0.4.
     *
     * L'écran pose un bandeau de titre et un bouton retour par-dessus la carte.
     * Google cadre au plus juste et ignore toute notion de marge : le marqueur
     * du restaurant se retrouvait sous le bandeau. On agrandit donc le cadre
     * vers le NORD pour que le trajet redescende sous cette zone.
     */
    topPad?: number;
  }): Promise<Buffer | null> {
    const { originLat, originLng, destLat, destLng } = params;
    const width = Math.min(Math.max(Math.round(params.width) || 400, 100), 640);
    const height = Math.min(Math.max(Math.round(params.height) || 200, 80), 640);
    const scale = params.scale === 2 ? 2 : 1;
    const topPad = Math.min(Math.max(Number(params.topPad) || 0, 0), 0.4);

    // `v3` : style et marqueurs ont changé, les vignettes déjà en cache montreraient encore
    // l'ancienne carte chargée pendant toute la durée de vie du cache.
    const cacheKey = this.key(
      'static_route_v3',
      `${originLat.toFixed(5)},${originLng.toFixed(5)}_${destLat.toFixed(5)},${destLng.toFixed(5)}_${width}x${height}@${scale}_t${topPad.toFixed(2)}`,
    );

    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return Buffer.from(cached, 'base64');

    const itineraire = await this.getDirections({
      originLat,
      originLng,
      destLat,
      destLng,
    });

    const construireUrl = (avecPastilles: boolean) => {
      const url = new URL(`${BASE_URL}/staticmap`);
      url.searchParams.set('size', `${width}x${height}`);
      url.searchParams.set('scale', String(scale));
      url.searchParams.set('language', 'fr');
      url.searchParams.set('key', this.apiKey);
      for (const regle of MapsService.STYLE_VIGNETTE) {
        url.searchParams.append('style', regle);
      }

      /**
       * Pastilles maison plutôt que les lettres « R » et « C ».
       *
       * Google va CHERCHER ces images sur notre serveur. S'il n'y arrive pas il
       * ne signale rien dans le code HTTP : il répond 200, remplace nos
       * pastilles par ses épingles rouges, incruste un bandeau « Map error »
       * dans l'image, et ne le dit QUE dans l'en-tête `x-staticmap-api-warning`.
       * D'où la seconde tentative sans pastilles, plus bas.
       *
       * `anchor:center` : ce sont des pastilles rondes, pas des gouttes. Sans
       * cette précision Google les accroche par le bas et le point désigné se
       * retrouve décalé d'une demi-icône.
       */
      // `urlApi` gère les deux formes de `BASE_URL`, avec ou sans préfixe.
      const racine = racinePublique();
      if (avecPastilles && !racine) {
        /**
         * Dégradation SILENCIEUSE, et c'est précisément ce qui a coûté une
         * après-midi : sans `BASE_URL`, les pastilles ne sont même pas
         * demandées, Google ne signale donc rien, et l'image revient avec les
         * lettres sans qu'aucune trace n'existe. On le dit, une fois par
         * démarrage pour ne pas noyer le journal.
         */
        if (!MapsService.baseUrlSignalee) {
          MapsService.baseUrlSignalee = true;
          this.logger.warn(
            '[Maps] BASE_URL absente de l\'environnement : vignette servie avec les ' +
              'marqueurs de secours (lettres R et C) au lieu des pastilles.',
          );
        }
      }
      if (avecPastilles && racine) {
        url.searchParams.append(
          'markers',
          `anchor:center|icon:${urlApi('maps/pin/restaurant.png')}|${originLat},${originLng}`,
        );
        url.searchParams.append(
          'markers',
          `anchor:center|icon:${urlApi('maps/pin/client.png')}|${destLat},${destLng}`,
        );
      } else {
        url.searchParams.append(
          'markers',
          `color:0xF17922|label:R|${originLat},${originLng}`,
        );
        url.searchParams.append(
          'markers',
          `color:0x0F172A|label:C|${destLat},${destLng}`,
        );
      }

      if (itineraire?.coordinates?.length) {
        // On échantillonne : l'URL d'une Static Map est plafonnée à 8192
        // caractères, et une trace urbaine compte plusieurs centaines de points.
        const points = itineraire.coordinates;
        const pas = Math.max(1, Math.ceil(points.length / 70));
        const retenus = points.filter((_, i) => i % pas === 0);
        const dernier = points[points.length - 1];
        if (retenus[retenus.length - 1] !== dernier) retenus.push(dernier);

        url.searchParams.set(
          'path',
          `color:0xF17922C0|weight:4|` +
            retenus.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join('|'),
        );
      }

      /**
       * CADRAGE MAÎTRISÉ, plutôt que l'ajustement automatique de Google.
       *
       * Laissé à lui-même, Google colle le trajet aux bords : nos pastilles
       * font 56 px et sont accrochées par leur CENTRE, donc la moitié déborde
       * et se fait couper. Et il ne connaît aucune notion de marge, si bien que
       * le marqueur du restaurant passait sous le bandeau de titre de l'écran.
       *
       * On lui donne donc une boîte explicite, via deux points `visible` :
       * l'emprise réelle du trajet, élargie d'une marge sur les quatre côtés,
       * plus la bande demandée en haut par l'écran.
       */
      const lats = [originLat, destLat, ...(itineraire?.coordinates ?? []).map((c) => c.latitude)];
      const lngs = [originLng, destLng, ...(itineraire?.coordinates ?? []).map((c) => c.longitude)];
      const nord = Math.max(...lats);
      const sud = Math.min(...lats);
      const est = Math.max(...lngs);
      const ouest = Math.min(...lngs);

      // Marge de respiration : de quoi contenir une pastille entière, même sur
      // un trajet très court dont l'emprise est presque un point.
      const margeLat = Math.max((nord - sud) * 0.18, 0.0009);
      const margeLng = Math.max((est - ouest) * 0.18, 0.0009);

      // Bande du haut : pour que le trajet occupe les (1 - p) du bas, le cadre
      // doit monter de p/(1-p) fois sa hauteur.
      const hauteur = nord - sud + 2 * margeLat;
      const bandeHaute = topPad > 0 ? (hauteur * topPad) / (1 - topPad) : 0;

      url.searchParams.append(
        'visible',
        `${(nord + margeLat + bandeHaute).toFixed(6)},${(ouest - margeLng).toFixed(6)}`,
      );
      url.searchParams.append(
        'visible',
        `${(sud - margeLat).toFixed(6)},${(est + margeLng).toFixed(6)}`,
      );

      return url.toString();
    };

    /** Télécharge et rapporte l'avertissement que Google glisse en en-tête. */
    const telecharger = async (url: string) => {
      this.compteur.compter('vignette');
      const reponse = await fetch(url);
      if (!reponse.ok) {
        this.logger.warn(`[Maps] StaticRoute HTTP ${reponse.status}`);
        return null;
      }
      return {
        image: Buffer.from(await reponse.arrayBuffer()),
        avertissement: reponse.headers.get('x-staticmap-api-warning'),
      };
    };

    try {
      let resultat = await telecharger(construireUrl(true));
      if (!resultat) return null;

      /**
       * Google a répondu 200 mais signale un problème : nos pastilles n'ont pas
       * pu être chargées, et l'image porte ses épingles rouges plus un bandeau
       * d'erreur. On rejoue SANS pastilles : les marqueurs couleur et lettre ne
       * dépendent de rien, l'image reste propre.
       */
      if (resultat.avertissement) {
        this.logger.warn(`[Maps] StaticRoute avertissement Google: ${resultat.avertissement}`);
        const repli = await telecharger(construireUrl(false));
        if (repli && !repli.avertissement) {
          resultat = repli;
        } else {
          // Toujours dégradée : on la rend au client pour ne pas laisser un
          // écran vide, mais on ne la fige SURTOUT PAS en cache.
          return (repli ?? resultat).image;
        }
      }

      await this.cache.set(cacheKey, resultat.image.toString('base64'), TTL.STATIC_ROUTE);
      return resultat.image;
    } catch (err) {
      this.logger.warn(`[Maps] StaticRoute error: ${(err as Error).message}`);
      return null;
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
    // `types` et le `viewport` de la geometrie disent la PRECISION du lieu : une
    // rue n'est pas un quartier. Sans eux, l'application cadre la carte de la
    // meme facon sur un portail et sur un quartier entier, et le client croit
    // verifier un point alors qu'il regarde un centroide a un kilometre.
    url.searchParams.set(
      'fields',
      'geometry,formatted_address,name,address_components,types',
    );
    url.searchParams.set('language', 'fr');
    url.searchParams.set('key', this.apiKey);
    if (sessionToken) url.searchParams.set('sessiontoken', sessionToken);

    this.compteur.compter('details_lieu');
    try {
      const data = await this.googleFetch<{
        status: string;
        result?: {
          place_id: string;
          name: string;
          formatted_address: string;
          geometry: {
            location: { lat: number; lng: number };
            viewport?: {
              northeast: { lat: number; lng: number };
              southwest: { lat: number; lng: number };
            };
          };
          address_components: any[];
          types?: string[];
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
        types: r.types ?? [],
        viewport: r.geometry.viewport ?? null,
      };

      await this.cache.set(cacheKey, result, TTL.PLACE_DETAILS);
      return result;
    } catch (err) {
      this.logger.warn(`[Maps] PlaceDetails error: ${(err as Error).message}`);
      return null;
    }
  }
}
