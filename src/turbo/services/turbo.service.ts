import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from 'src/database/services/prisma.service';
import { Address, DeliveryService, OrderStatus } from "@prisma/client";
import { TURBO_API, TURBO_API_KEY, mappingMethodPayment } from "../constantes/turbo.constante";
import { IFraisLivraison, IFraisLivraisonResponsePaginate } from "../dto/frais-livraison.response";
import { CommandeResponse, PaiementMethode } from "../interfaces/turbo.interfaces";
import { NotificationsSenderService } from "src/modules/notifications/services/notifications-sender.service";

@Injectable()
export class TurboService {
  private readonly logger = new Logger(TurboService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsSender: NotificationsSenderService,
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
          "modePaiement": order.paiements.length ? mappingMethodPayment[order.paiements[0].mode] : PaiementMethode.ESPECE,
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

        const data = await response.json().catch(() => null);

        // Échec Turbo : soit HTTP non-2xx, soit un corps d'erreur ({ statut, message }).
        const isError =
          !response.ok ||
          (data && typeof data === "object" && "statut" in data);
        if (isError) {
          const reason =
            (data && (data.message || data.error)) || `HTTP ${response.status}`;
          await this.reportDispatchFailure(order, String(reason));
          return null;
        }

        this.logger.log(`Course Turbo créée pour la commande ${order.reference}.`);
        return data as CommandeResponse;
      } catch (error) {
        // Erreur réseau / exception : même traitement (visible, pas avalé).
        await this.reportDispatchFailure(order, (error as Error)?.message ?? "erreur réseau");
        return null;
      }
    }
  }

  /**
   * Un dispatch Turbo a échoué : la commande ne sera PAS affectée à un livreur
   * automatiquement. On rend l'échec VISIBLE (log explicite + alerte cloche au
   * staff) au lieu de l'avaler silencieusement, pour un traitement manuel.
   */
  private async reportDispatchFailure(order: any, reason: string) {
    this.logger.error(
      `❌ Envoi Turbo échoué — commande ${order.reference} (resto ${order.restaurant?.name ?? order.restaurant_id}) : ${reason}`,
    );
    try {
      await this.notificationsSender.sendTurboDispatchFailedBell(order, reason);
    } catch (e) {
      this.logger.warn(`Alerte échec Turbo non envoyée : ${(e as Error)?.message}`);
    }
  }

  async obtenirFraisLivraison({ apikey, latitude, longitude }: { apikey: string, latitude: number, longitude: number }): Promise<IFraisLivraison[]> {
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

  async obtenirFraisLivraisonParRestaurant(apikey: string, page?: number, size?: number): Promise<IFraisLivraisonResponsePaginate | null> {
    try {
      const response = await fetch(`${TURBO_API.LISTE_FRAIS}?page=${page || 0}&size=${size || 200}`, {
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
}