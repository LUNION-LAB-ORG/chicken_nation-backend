import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from 'src/database/services/prisma.service';
import { Address, DeliveryService, OrderStatus } from "@prisma/client";
import { LivraisonsByKm, TURBO_API, TURBO_API_KEY, mappingMethodPayment } from "../constantes/turbo.constante";
import { IFraisLivraison, IFraisLivraisonResponsePaginate } from "../dto/frais-livraison.response";
import { CommandeResponse } from "../interfaces/turbo.interfaces";

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
          "modePaiement": mappingMethodPayment[order.paiements[0].mode],
          "prix": order.amount,
          "livraisonPaye": order.paied,
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
        console.log("🚀 ~ file: turbo.service.ts:72 ~ TurboService ~ creerCourse ~ formData:", formData)
        console.log({data});
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
      console.log(error);
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
   * @returns Le prix de la livraison ou null si aucune correspondance n'est trouvée.
   */
  getPrixLivraison(distanceKm: number): number | null {
    for (const palier of LivraisonsByKm) {
      if (distanceKm <= palier.maxKm) {
        return palier.price;
      }
    }
    return null;
  }

}