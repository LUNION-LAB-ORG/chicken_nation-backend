import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from 'src/database/services/prisma.service';
import { Address, DeliveryService, OrderStatus } from "@prisma/client";
import { TURBO_API, TURBO_API_KEY, mappingMethodPayment } from "../constantes/turbo.constante";
import { IFraisLivraison, IFraisLivraisonResponsePaginate } from "../dto/frais-livraison.response";
import { CommandeResponse, PaiementMode } from "../interfaces/turbo.interfaces";

@Injectable()
export class TurboService {
  constructor(
    private readonly prisma: PrismaService,
  ) { }

  async creerCourse(order_id: string, apikey: string) {
    apikey = apikey || TURBO_API_KEY;

    const order = await this.prisma.order.findUnique({
      where: {
        id: order_id
      },
      include: {
        restaurant: true,
        customer: true,
        paiements: true,
      }
    });

    if (order && order.status === OrderStatus.READY && order.delivery_service === DeliveryService.TURBO) {
      const adresse = this.validateAddress(order.address as string ?? "");

      const formData = {
        commandes: [{
          "numero": order.reference,
          "destinataire": {
            "nomComplet": order.fullname,
            "contact": order.phone,
            "email": order.email
          },
          "lieuRecuperation": {
            "latitude": order.restaurant.latitude,
            "longitude": order.restaurant.longitude,
          },
          "lieuLivraison": {
            "latitude": adresse.latitude,
            "longitude": adresse.longitude,
          },
          "zoneId": order.zone_id,
          "modePaiement": order.paiements.length ? mappingMethodPayment[order.paiements[0].mode] : PaiementMode.ESPECE,
          "prix": order.amount - order.delivery_fee,
          "livraisonPaye": order.paied,
          "statut": "EN_ATTENTE_RECUPERATION"
        }]
      }

      try {
        const response = await fetch(`${TURBO_API.CREATION_COURSE}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': apikey,
          },
          body: JSON.stringify(formData),
        });

        const data = await response.json();
        if (typeof data === "object" && "statut" in data) {
          throw new Error(data?.message ?? "Une erreur est survenue");
        }

        return data as CommandeResponse;
      } catch (error) {
        console.log(error);
        return null;
      }
    }
  }

  async obtenirFraisLivraison({ apikey, latitude, longitude }: { apikey: string, latitude: number, longitude: number }): Promise<IFraisLivraison[]> {
    apikey = apikey || TURBO_API_KEY;
    try {
      const response = await fetch(`${TURBO_API.FRAIS_LIVRAISON}?latitude=${latitude}&longitude=${longitude}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apikey,
        },
      });
      const data = await response.json();

      if (typeof data === "object" && "statut" in data) {
        throw new Error(data?.message ?? "Une erreur est survenue");
      }

      return data as IFraisLivraison[];
    } catch (error) {
      return [];
    }
  }

  async obtenirFraisLivraisonParRestaurant(apikey: string): Promise<IFraisLivraisonResponsePaginate | null> {
    apikey = apikey || TURBO_API_KEY;
    try {
      const response = await fetch(`${TURBO_API.LISTE_FRAIS}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apikey,
        },
      });

      const data = await response.json();
      if (typeof data === "object" && "statut" in data) {
        throw new Error(data?.message ?? "Une erreur est survenue");
      }

      return data as IFraisLivraisonResponsePaginate;
    } catch (error) {
      return null;
    }
  }

  // Valider l'adresse de livraison
  private validateAddress(address: string) {
    if (!address) {
      throw new BadRequestException('Adresse de livraison invalide ou introuvable');
    }
    return JSON.parse(address) as Address;
  }

  /**
   * Calcule le prix de la livraison en fonction de la distance en km.
   * @param distanceKm La distance de la livraison en kilomètres.
   * @returns Le prix de la livraison.
   */
  getPrixLivraison(distanceKm: number): number {
    return this.calculateDeliveryPrice(distanceKm);
  }



  /**
   * Calcule le prix de livraison basé sur la distance (Modèle Abidjan/Yango)
   * @param {number} distanceInKm - La distance exacte (ex: 5.4)
   * @returns {number} - Le prix final arrondi en FCFA
   */
  private calculateDeliveryPrice(distanceInKm: number) {
    // --- CONFIGURATION ---
    const BASE_DIST_KM = 1.5;       // Forfait 1000F jusqu'à 1.5 km
    const BASE_PRICE = 1000;        // Prix minimum
    const PRICE_PER_KM_URBAN = 250;  // Nouveau tarif urbain
    const PRICE_PER_KM_LONG = 200;   // On peut laisser à 200 pour la longue distance

    let finalPrice = 0;

    // --- LOGIQUE DE CALCUL ---
    if (distanceInKm <= BASE_DIST_KM) {
      finalPrice = BASE_PRICE;
    }
    else if (distanceInKm <= 10) {
      const extraKm = distanceInKm - BASE_DIST_KM;
      finalPrice = BASE_PRICE + (extraKm * PRICE_PER_KM_URBAN);
    }
    else {
      const priceForFirst10Km = BASE_PRICE + ((10 - BASE_DIST_KM) * PRICE_PER_KM_URBAN);
      const extraKm = distanceInKm - 10;
      finalPrice = priceForFirst10Km + (extraKm * PRICE_PER_KM_LONG);
    }

    // Arrondi par palier de 500 FCFA
    return Math.ceil(finalPrice / 500) * 500;
  }
}