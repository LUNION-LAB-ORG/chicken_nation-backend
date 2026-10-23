import { Module } from '@nestjs/common';

import { CompteurAppelsGoogleService } from './compteur-appels-google.service';
import { MapsAssetsController } from './maps-assets.controller';
import { MapsController } from './maps.controller';
import { MapsService } from './maps.service';
import { redisCompteurGoogleProvider } from './redis-compteur-google.provider';

/**
 * Module Maps — proxy sécurisé vers Google Maps APIs avec cache Redis.
 *
 * Expose 4 endpoints :
 *  - GET /maps/directions           → Directions API (cache 3 min, trafic compris)
 *  - GET /maps/geocode/reverse      → Geocoding API (cache 24h)
 *  - GET /maps/places/autocomplete  → Places Autocomplete API (cache 5 min)
 *  - GET /maps/places/details/:id   → Places Details API (cache 7 jours)
 *
 * Le cache est fourni par le `CacheModule` global (Redis via @nestjs/cache-manager).
 * La clé Google Maps est lue depuis `process.env.GOOGLE_MAPS_API_KEY`.
 *
 * Chaque appel réellement envoyé à Google est compté par fonction et par jour
 * (`CompteurAppelsGoogleService`) ; ceux qui ont un repli sans Google
 * (itinéraire routier, détour, temps de trajet) s'arrêtent au plafond
 * quotidien `maps.plafond_appels_jour`.
 */
@Module({
  controllers: [MapsController, MapsAssetsController],
  providers: [MapsService, CompteurAppelsGoogleService, redisCompteurGoogleProvider],
  exports: [MapsService, CompteurAppelsGoogleService],
})
export class MapsModule {}
