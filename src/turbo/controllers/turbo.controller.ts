import { Controller, Post, Body } from '@nestjs/common';
import { TurboService } from '../services/turbo.service';

@Controller('turbo')
export class TurboController {
  constructor(private readonly turboService: TurboService) { }

  @Post('creer-course')
  async creerCourse(@Body() body: { order_id: string, apikey: string }) {
    return this.turboService.creerCourse(body.order_id, body.apikey);
  }

  @Post('obtenir-frais-livraison')
  async obtenirFraisLivraison(@Body() body: { apikey: string, latitude: number, longitude: number }) {
    return this.turboService.obtenirFraisLivraison(body.apikey, body.latitude, body.longitude);
  }

  @Post('obtenir-frais-livraison-par-restaurant')
  async obtenirFraisLivraisonParRestaurant(@Body() body: { apikey: string }) {
    return this.turboService.obtenirFraisLivraisonParRestaurant(body.apikey);
  }
}
