import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { racinePublique, urlApi } from 'src/common/utils/url-publique.util';
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
  REVERSE_GEOCODE:  24 * 60 * 60 * 1000,    //  24h     — l'adresse d'un point reste stable
  AUTOCOMPLETE:      5 * 60 * 1000,         //   5 min  — suggestions fraîches
  PLACE_DETAILS:     7 * 24 * 60 * 60 * 1000, // 7 jours — les détails d'un lieu sont immuables
  // 12h et non 7 jours : une vignette dépend de choses qui peuvent casser (nos
  // pastilles, notre URL publique). Une image dégradée figée une semaine, c'est
  // la panne multipliée par la durée du cache.
  STATIC_ROUTE:     12 * 60 * 60 * 1000,    //  12h     — image d'itinéraire
} as const;

const BASE_URL = 'https://maps.googleapis.com/maps/api';

/**
 * Temps passé chez un client avant de repartir : trouver la porte, remettre la
 * commande, faire saisir le code. Google ne compte QUE la conduite, or sur une
 * course groupée ces arrêts s'additionnent et pèsent lourd dans l'estimation.
 * Ajustable via `MAPS_STOP_SECONDS`.
 */
const STOP_SECONDS_PER_DELIVERY = Number(process.env.MAPS_STOP_SECONDS ?? 180);

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
      }>(url.toString());

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
   * d'échec, pour que l'appelant retombe sur son classement habituel.
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
      }>(url.toString());

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
  }): Promise<Buffer | null> {
    const { originLat, originLng, destLat, destLng } = params;
    const width = Math.min(Math.max(Math.round(params.width) || 400, 100), 640);
    const height = Math.min(Math.max(Math.round(params.height) || 200, 80), 640);
    const scale = params.scale === 2 ? 2 : 1;

    // `v3` : style et marqueurs ont changé, les vignettes déjà en cache montreraient encore
    // l'ancienne carte chargée pendant toute la durée de vie du cache.
    const cacheKey = this.key(
      'static_route_v3',
      `${originLat.toFixed(5)},${originLng.toFixed(5)}_${destLat.toFixed(5)},${destLng.toFixed(5)}_${width}x${height}@${scale}`,
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
      const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
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

      return url.toString();
    };

    /** Télécharge et rapporte l'avertissement que Google glisse en en-tête. */
    const telecharger = async (url: string) => {
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
