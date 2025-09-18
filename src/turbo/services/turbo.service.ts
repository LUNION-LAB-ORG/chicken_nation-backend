import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from 'src/database/services/prisma.service';
import { Address, OrderStatus } from "@prisma/client";
import { TURBO_API, mappingMethodPayment } from "../constantes/turbo.constante";
import { IFraisLivraison, IFraisLivraisonResponsePaginate } from "../dto/frais-livraison.response";

@Injectable()
export class TurboService {
  constructor(
    private readonly prisma: PrismaService,
  ) { }

  async creerCourse(order_id: string, apikey: string) {
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

    if (order && order.status === OrderStatus.READY) {
      const adresse = this.validateAddress(order.address as string ?? "");

      // TODO : Récupération de la zone sinon annuler la création de la course 
      // et notification du système à chicken_nation que la course n'a pas été prise en compte par Turbo et qu'elle doit être 
      // traitée manuellement
      const zone = await this.obtenirFraisLivraison(apikey, adresse.latitude, adresse.longitude);
      if (!zone || zone.length === 0) {
        throw new Error("Zone non trouvée");
      }
      const formData = {
        "zoneId": zone[0].id,
        "numero": order.reference,
        "destinataire": {
          "nom": order.fullname,
          "telephone": order.phone,
          "email": order.email
        },
        "lieuRecuperation": {
          "latitude": order.restaurant.latitude,
          "longitude": order.restaurant.longitude,
          "adresse": order.restaurant.address
        },
        "lieuLivraison": {
          "latitude": adresse.latitude,
          "longitude": adresse.longitude,
          "adresse": adresse.address
        },
        "modePaiement": mappingMethodPayment[order.paiements[0].mode],
        "prix": order.amount,
        "livraisonPaye": order.paied,
      }

      const response = await fetch(`${TURBO_API.CREATION_COURSE}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apikey,
        },
        body: JSON.stringify(formData),
      });

      console.log(response);
    }
  }

  async obtenirFraisLivraison(apikey: string, latitude: number, longitude: number): Promise<IFraisLivraison[]> {
    try {
      const response = await fetch(`${TURBO_API.FRAIS_LIVRAISON}?latitude=${latitude}&longitude=${longitude}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apikey,
        },
      });
      const data = await response.json() as IFraisLivraison[];
      return data;
    } catch (error) {
      console.log(error);
      return [];
    }
  }

  async obtenirFraisLivraisonParRestaurant(apikey: string): Promise<IFraisLivraisonResponsePaginate | null> {

    try {
      const response = await fetch(`${TURBO_API.LISTE_FRAIS}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apikey,
        },
      });
      const data = await response.json() as IFraisLivraisonResponsePaginate;
      return data;
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
}