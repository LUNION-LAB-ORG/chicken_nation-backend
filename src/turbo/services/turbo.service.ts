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
          // Encaissement à la livraison : montant TTC dû par le client (frais de
          // livraison inclus), 0 si déjà payée. Champ explicite du contrat — le
          // livreur Turbo ne doit rien déduire de prix/frais lui-même.
          "montantAEncaisser": order.paied ? 0 : order.amount,
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
   * ENVOI PAR GROUPE — flux courant de sous-traitance (remplace l'envoi commande
   * par commande).
   *
   * Une Course Chicken Nation peut contenir PLUSIEURS commandes ; chez Turbo,
   * une course = UNE commande. On envoie donc **un seul appel** contenant N
   * `commandes` : Turbo en fait un GROUPE de courses qu'un même livreur accepte
   * en bloc (l'endpoint accepte nativement un tableau).
   *
   * Deux informations Chicken Nation accompagnent le groupe et DOIVENT être
   * restituées au livreur Turbo :
   *   • `codeRetrait`      — code que le livreur annonce à la caissière. Sans
   *                          lui, il ne peut pas récupérer les plats : le process
   *                          restaurant reste strictement inchangé.
   *   • `referenceCourse`  — référence de la course CN (rapprochement, support).
   *
   * Elles sont envoyées à la fois à la racine (niveau groupe) ET sur chaque
   * commande : on ne maîtrise pas leur parseur, cette redondance garantit qu'ils
   * les trouvent quel que soit le niveau qu'ils lisent.
   *
   * Renvoie les ids des commandes effectivement transmises (vide = échec).
   */
  async creerCourseGroupe(params: {
    courseId: string;
    apikey: string;
    /**
     * Coupe la cloche staff en cas d'échec. À poser sur les RELANCES
     * automatiques (cron toutes les 30 s) : la première tentative alerte,
     * les suivantes journalisent seulement — sinon le staff reçoit la même
     * cloche en boucle tant que Turbo est injoignable.
     */
    muteFailureBell?: boolean;
  }): Promise<{
    sentOrderIds: string[];
    response: CommandeResponse | null;
    /**
     * `true` quand l'issue est INCERTAINE (timeout / coupure réseau) : Turbo a
     * PEUT-ÊTRE créé le groupe sans que la réponse nous parvienne. L'appelant ne
     * doit alors SURTOUT PAS repartir en recherche interne, sous peine
     * d'envoyer deux livreurs sur la même commande.
     */
    uncertain?: boolean;
  }> {
    const { courseId, apikey, muteFailureBell = false } = params;

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        restaurant: true,
        deliveries: {
          orderBy: { sequence_order: 'asc' },
          include: {
            order: { include: { restaurant: true, customer: true, paiements: true } },
          },
        },
      },
    });
    if (!course) {
      this.logger.error(`Groupe Turbo : course ${courseId} introuvable.`);
      return { sentOrderIds: [], response: null };
    }

    // Seules les commandes réellement livrables partent (mêmes garde-fous que
    // l'envoi unitaire : prêtes et marquées livraison Turbo).
    const eligibles = course.deliveries
      .map((d) => d.order)
      .filter(
        (o) =>
          o &&
          o.status === OrderStatus.READY &&
          o.delivery_service === DeliveryService.TURBO,
      );

    if (eligibles.length === 0) {
      this.logger.warn(`Groupe Turbo ${course.reference} : aucune commande éligible.`);
      return { sentOrderIds: [], response: null };
    }

    const commandes = eligibles.map((order) => {
      const adresse = this.validateAddress((order.address as string) ?? '');
      return {
        numero: order.reference,
        // Identité du GROUPE, répétée par commande (cf. commentaire ci-dessus).
        referenceCourse: course.reference,
        codeRetrait: course.pickup_code,
        destinataire: {
          nomComplet: order.fullname,
          contact: order.phone,
          email: order.email,
        },
        lieuRecuperation: {
          latitude: order.restaurant.latitude,
          longitude: order.restaurant.longitude,
        },
        lieuLivraison: {
          latitude: adresse.latitude,
          longitude: adresse.longitude,
        },
        zoneId: order.zone_id,
        modePaiement: order.paiements.length
          ? mappingMethodPayment[order.paiements[0].mode]
          : PaiementMethode.ESPECE,
        prix: order.amount - order.delivery_fee,
        livraisonPaye: order.paied,
        // Encaissement à la livraison : montant TTC dû par le client (frais de
        // livraison inclus), 0 si déjà payée. Champ explicite du contrat — le
        // livreur Turbo ne doit rien déduire de prix/frais lui-même.
        montantAEncaisser: order.paied ? 0 : order.amount,
        statut: 'EN_ATTENTE_RECUPERATION',
      };
    });

    const formData = {
      // Niveau GROUPE : ce que le livreur doit voir et annoncer au restaurant.
      referenceCourse: course.reference,
      codeRetrait: course.pickup_code,
      commandes,
    };

    try {
      const response = await fetch(`${TURBO_API.CREATION_COURSE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apikey },
        body: JSON.stringify(formData),
      });
      const data = await response.json().catch(() => null);

      const isError =
        !response.ok || (data && typeof data === 'object' && 'statut' in data);
      if (isError) {
        const reason = (data && (data.message || data.error)) || `HTTP ${response.status}`;
        if (muteFailureBell) {
          this.logger.warn(
            `Relance groupe Turbo ${course.reference} échouée (silencieuse) : ${String(reason)}`,
          );
        } else {
          // Alerte portée par la 1re commande (le staff identifie la course).
          await this.reportDispatchFailure(eligibles[0], String(reason));
        }
        return { sentOrderIds: [], response: null };
      }

      // Marqueur de replay (contrat Turbo) : 200 + { replay: true } = cette
      // referenceCourse avait DÉJÀ été reçue — le groupe existe chez eux
      // (typiquement : notre envoi précédent avait échoué côté réseau après
      // leur création). On le traite comme un succès : le groupe est vivant.
      if (data && typeof data === 'object' && (data as any).replay === true) {
        this.logger.warn(
          `Groupe Turbo ${course.reference} : REPLAY détecté (groupe déjà existant chez Turbo, id ${(data as any).groupeId ?? '?'}).`,
        );
      } else {
        this.logger.log(
          `Groupe Turbo créé pour la course ${course.reference} (code ${course.pickup_code}) : ${commandes.length} commande(s).`,
        );
      }
      return {
        sentOrderIds: eligibles.map((o) => o.id),
        response: data as CommandeResponse,
      };
    } catch (error) {
      // Coupure réseau / timeout : leur groupe a PEUT-ÊTRE été créé. On le
      // signale comme INCERTAIN pour interdire tout repli en interne.
      if (muteFailureBell) {
        this.logger.warn(
          `Relance groupe Turbo ${course.reference} : issue incertaine (silencieuse) — ${(error as Error)?.message ?? 'erreur réseau'}`,
        );
      } else {
        await this.reportDispatchFailure(
          eligibles[0],
          (error as Error)?.message ?? 'erreur réseau',
        );
      }
      return { sentOrderIds: [], response: null, uncertain: true };
    }
  }

  /**
   * ANNULATION DU GROUPE côté Turbo (CN → Turbo) — utilisée par la REPRISE EN
   * INTERNE du backoffice : avant de reproposer la course aux livreurs CN, on
   * annule le groupe chez Turbo pour ne JAMAIS avoir deux livreurs sur les
   * mêmes commandes.
   *
   * Contrat (validé avec Turbo) : POST sans body, X-API-KEY ;
   *   - 200 → annulé chez eux (idempotent, aucun webhook en écho) ;
   *   - 409 → un livreur a DÉJÀ accepté la mission : reprise impossible ;
   *   - 404 → référence inconnue chez eux (groupe jamais créé) : reprise sûre.
   * Erreur réseau / 401 / autre → issue INCERTAINE : l'appelant doit REFUSER
   * la reprise (leur course est peut-être toujours vivante).
   */
  async annulerCourseGroupe(params: {
    referenceCourse: string;
    apikey: string;
  }): Promise<{
    ok: boolean;
    courierAssigned?: boolean;
    notFound?: boolean;
    uncertain?: boolean;
  }> {
    const { referenceCourse, apikey } = params;
    try {
      const response = await fetch(TURBO_API.ANNULATION_COURSE(referenceCourse), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apikey },
      });

      if (response.ok) {
        this.logger.log(`Groupe Turbo ${referenceCourse} annulé côté Turbo (reprise en interne).`);
        return { ok: true };
      }
      if (response.status === 409) {
        this.logger.warn(
          `Annulation Turbo refusée pour ${referenceCourse} : un livreur a déjà accepté la mission.`,
        );
        return { ok: false, courierAssigned: true };
      }
      if (response.status === 404) {
        this.logger.warn(
          `Annulation Turbo ${referenceCourse} : référence inconnue chez Turbo (groupe jamais créé).`,
        );
        return { ok: true, notFound: true };
      }
      this.logger.error(
        `Annulation Turbo ${referenceCourse} : réponse inattendue HTTP ${response.status}.`,
      );
      return { ok: false, uncertain: true };
    } catch (error) {
      this.logger.error(
        `Annulation Turbo ${referenceCourse} : erreur réseau — ${(error as Error)?.message}.`,
      );
      return { ok: false, uncertain: true };
    }
  }

  /**
   * CONFIRMATION DU RETRAIT (CN → Turbo).
   *
   * Chez Chicken Nation, c'est la CAISSIÈRE — jamais le livreur — qui atteste la
   * remise des plats : c'est le garde-fou anti-fraude du process, et il ne doit
   * pas sauter parce que la course est sous-traitée. Turbo n'ayant aucun moyen
   * de connaître cette validation, c'est nous qui la leur signalons : leur groupe
   * passe « récupéré » et leur `picked_up` est déclenché.
   *
   * Best-effort : un échec ici ne casse JAMAIS la validation côté CN (les plats
   * sont déjà remis au livreur, la commande doit avancer quoi qu'il arrive).
   */
  async confirmerRetrait(params: {
    referenceCourse: string;
    apikey: string;
    restaurantId?: string;
  }): Promise<boolean> {
    const { referenceCourse, apikey, restaurantId } = params;

    // Un appel PERDU laisse leur groupe « non récupéré » : le livreur se
    // retrouve bloqué dans son application avec les sacs en main. On relance
    // donc 3 fois (backoff court) avant d'abandonner.
    const DELAIS_MS = [0, 1500, 4000];

    for (let essai = 0; essai < DELAIS_MS.length; essai++) {
      if (DELAIS_MS[essai] > 0) {
        await new Promise((r) => setTimeout(r, DELAIS_MS[essai]));
      }
      try {
        const response = await fetch(TURBO_API.CONFIRMATION_RETRAIT(referenceCourse), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-KEY': apikey },
          body: JSON.stringify({ referenceCourse }),
        });
        if (response.ok) {
          this.logger.log(
            `Retrait confirmé auprès de Turbo pour la course ${referenceCourse}${essai > 0 ? ` (essai ${essai + 1})` : ''}.`,
          );
          return true;
        }

        // 404/501 : l'endpoint n'est pas ENCORE livré côté Turbo (déploiement en
        // cours de leur côté). Ce n'est pas une panne : relancer et alerter le
        // staff n'apporterait que du bruit. On sort proprement, en silence.
        // Dès qu'ils déploient, le flux nominal reprend sans rien changer ici.
        if (response.status === 404 || response.status === 501) {
          this.logger.warn(
            `Confirmation retrait : endpoint Turbo pas encore disponible (HTTP ${response.status}) — ignoré pour ${referenceCourse}.`,
          );
          return false;
        }

        this.logger.warn(
          `Confirmation retrait Turbo refusée (${referenceCourse}, essai ${essai + 1}/${DELAIS_MS.length}) : HTTP ${response.status}`,
        );
      } catch (error) {
        this.logger.warn(
          `Confirmation retrait Turbo échouée (${referenceCourse}, essai ${essai + 1}/${DELAIS_MS.length}) : ${(error as Error)?.message}`,
        );
      }
    }

    // Toutes les relances ont échoué : la désynchronisation est certaine et le
    // livreur est probablement bloqué → le staff doit pouvoir agir tout de suite.
    this.logger.error(
      `❌ Retrait NON synchronisé avec Turbo pour la course ${referenceCourse} — livreur potentiellement bloqué.`,
    );
    if (restaurantId) {
      await this.notificationsSender
        .sendTurboPickupSyncFailedBell({ reference: referenceCourse, restaurantId })
        .catch(() => undefined);
    }
    return false;
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