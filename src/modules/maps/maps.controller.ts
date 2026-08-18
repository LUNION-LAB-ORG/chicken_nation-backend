import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  NotFoundException,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { DirectionsQueryDto } from './dto/directions.dto';
import { StaticRouteQueryDto } from './dto/static-route.dto';
import { GeocodeReverseQueryDto } from './dto/geocode-reverse.dto';
import { PlacesAutocompleteQueryDto, PlaceDetailsQueryDto } from './dto/places-autocomplete.dto';
import { AnyJwtAuthGuard } from './guards/any-jwt-auth.guard';
import { MapsService } from './maps.service';

/**
 * Proxy sécurisé vers Google Maps APIs.
 *
 * Avantages vs appels directs depuis les apps :
 *  - La clé `GOOGLE_MAPS_API_KEY` reste côté serveur (jamais dans le bundle)
 *  - Cache Redis partagé → moins de requêtes facturées à Google
 *  - Point unique pour monitoring / quota management
 *
 * Tous les endpoints sont protégés par `AnyJwtAuthGuard` (customer, deliverer ou admin).
 */
@ApiTags('Maps')
@ApiBearerAuth()
@UseGuards(AnyJwtAuthGuard)
@Controller('maps')
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  /**
   * GET /maps/directions
   *
   * Calcule un itinéraire routier entre origin et destination (+ waypoints optionnels).
   * Cache 10 min.
   *
   * @example
   *   GET /maps/directions?originLat=5.36&originLng=-4.01&destLat=5.38&destLng=-3.99
   *   GET /maps/directions?...&waypoints=[{"latitude":5.37,"longitude":-4.0}]
   */
  /**
   * GET /maps/static-route
   *
   * Vignette PNG du trajet restaurant → client, pour l'aperçu du panier.
   * L'image est fabriquée côté serveur : la clé Google ne part jamais dans
   * l'application, qui reçoit des octets et non une URL signée.
   */
  @Get('static-route')
  @ApiOperation({ summary: "Vignette PNG d'un itinéraire (Static Maps)" })
  @Header('Cache-Control', 'private, max-age=600')
  async getStaticRoute(@Query() query: StaticRouteQueryDto, @Res() res: Response) {
    const image = await this.mapsService.staticRoute({
      originLat: query.originLat,
      originLng: query.originLng,
      destLat: query.destLat,
      destLng: query.destLng,
      width: query.width ?? 400,
      height: query.height ?? 200,
      scale: query.scale ?? 2,
      topPad: query.topPad ?? 0,
    });

    if (!image) {
      throw new NotFoundException('Vignette indisponible');
    }

    res.setHeader('Content-Type', 'image/png');
    res.send(image);
  }

  @Get('directions')
  @ApiOperation({ summary: 'Itinéraire routier (proxy Directions API)' })
  async getDirections(@Query() query: DirectionsQueryDto) {
    let waypoints: { latitude: number; longitude: number }[] | undefined;

    if (query.waypoints) {
      try {
        waypoints = JSON.parse(query.waypoints);
      } catch {
        waypoints = undefined;
      }
    }

    const result = await this.mapsService.getDirections({
      originLat: query.originLat,
      originLng: query.originLng,
      destLat: query.destLat,
      destLng: query.destLng,
      waypoints,
    });

    if (!result) {
      throw new NotFoundException('Itinéraire introuvable ou API indisponible');
    }

    return result;
  }

  /**
   * GET /maps/geocode/reverse
   *
   * Convertit des coordonnées GPS en adresse lisible.
   * Cache 24h.
   *
   * @example GET /maps/geocode/reverse?lat=5.36&lng=-4.0082
   */
  @Get('geocode/reverse')
  @ApiOperation({ summary: 'Géocodage inverse (coords → adresse)' })
  async reverseGeocode(@Query() query: GeocodeReverseQueryDto) {
    const result = await this.mapsService.reverseGeocode(query.lat, query.lng);
    if (!result) {
      throw new NotFoundException('Adresse introuvable pour ces coordonnées');
    }
    return result;
  }

  /**
   * GET /maps/places/autocomplete
   *
   * Suggestions d'adresses à partir d'une saisie partielle.
   * Cache 5 min.
   * Utiliser `sessionToken` (UUID côté client, reset après chaque sélection)
   * pour réduire le coût de facturation Places API de ~95%.
   *
   * @example GET /maps/places/autocomplete?input=Cocody&components=country:ci&sessionToken=uuid
   */
  @Get('places/autocomplete')
  @ApiOperation({ summary: 'Suggestions Places (proxy Places Autocomplete API)' })
  async placesAutocomplete(@Query() query: PlacesAutocompleteQueryDto) {
    return this.mapsService.placesAutocomplete({
      input: query.input,
      components: query.components,
      language: query.language,
      sessionToken: query.sessionToken,
    });
  }

  /**
   * GET /maps/places/details/:placeId
   *
   * Détails complets d'un lieu (coords, adresse, composants).
   * Cache 7 jours.
   * Passer le même `sessionToken` qu'en autocomplete pour facturer la session
   * entière comme un seul appel Details (~$0.017 au lieu de $0.017×N frappes).
   *
   * @example GET /maps/places/details/ChIJ...?sessionToken=uuid
   */
  @Get('places/details/:placeId')
  @ApiOperation({ summary: "Détails d'un lieu (proxy Places Details API)" })
  async placeDetails(
    @Param('placeId') placeId: string,
    @Query() query: PlaceDetailsQueryDto,
  ) {
    const result = await this.mapsService.placeDetails(placeId, query.sessionToken);
    if (!result) {
      throw new NotFoundException('Lieu introuvable');
    }
    return result;
  }
}
