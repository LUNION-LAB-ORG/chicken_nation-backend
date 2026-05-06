import { Module } from '@nestjs/common';

import { MapsController } from './maps.controller';
import { MapsService } from './maps.service';

/**
 * Module Maps — proxy sécurisé vers Google Maps APIs avec cache Redis.
 *
 * Expose 4 endpoints :
 *  - GET /maps/directions           → Directions API (cache 10 min)
 *  - GET /maps/geocode/reverse      → Geocoding API (cache 24h)
 *  - GET /maps/places/autocomplete  → Places Autocomplete API (cache 5 min)
 *  - GET /maps/places/details/:id   → Places Details API (cache 7 jours)
 *
 * Le cache est fourni par le `CacheModule` global (Redis via @nestjs/cache-manager).
 * La clé Google Maps est lue depuis `process.env.GOOGLE_MAPS_API_KEY`.
 */
@Module({
  controllers: [MapsController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
