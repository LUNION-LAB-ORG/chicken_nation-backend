import { Injectable } from '@nestjs/common';
import { subDays } from 'date-fns';
import { PrismaService } from 'src/database/services/prisma.service';

/**
 * Critères de segmentation d'une population de clients.
 *
 * Ce sont exactement les quinze critères de `SegmentFiltersDto` du module des
 * campagnes push, repris ici sans changement de nom : une définition de segment
 * enregistrée par le marketing doit continuer de fonctionner à l'identique,
 * quel que soit le canal qui la consomme.
 */
export interface CriteresAudience {
  name_contains?: string;
  phone_contains?: string;
  email_contains?: string;
  min_orders?: number;
  max_orders?: number;
  min_spent?: number;
  max_spent?: number;
  loyalty_level?: string;
  city?: string;
  min_points?: number;
  max_points?: number;
  registered_after?: string;
  registered_before?: string;
  last_order_days?: number;
  no_order_days?: number;
}

/**
 * Résolution d'une audience de clients, INDÉPENDAMMENT du canal.
 *
 * ⚠️ C'est le point de la refonte. Le moteur d'origine, dans
 * `push-campaign.service`, compte et résout ses audiences À TRAVERS la table
 * `NotificationSetting` (`push: true, active: true, expo_push_token != null`).
 * Autrement dit, un client sans jeton Expo n'existe pas pour lui. C'est correct
 * pour une notification, qui a besoin d'un jeton pour partir. Ce l'est beaucoup
 * moins pour un message, qui n'a besoin de rien : il s'écrit en base et le
 * client le lira quand il ouvrira l'application.
 *
 * Un segment est donc une définition de POPULATION, pas de canal. La
 * joignabilité se pose PAR-DESSUS, dans le module qui envoie, jamais ici. Sans
 * cette séparation, une diffusion de messages afficherait une audience
 * amputée de tous les clients sans jeton, sans que personne ne comprenne
 * pourquoi.
 *
 * Deux limites héritées, assumées et documentées plutôt que corrigées en
 * douce : les critères se combinent uniquement en ET, et la résolution
 * intersecte des identifiants en mémoire. Sur la taille de base du projet c'est
 * sans conséquence ; au-delà de quelques dizaines de milliers de clients, il
 * faudra une seule requête SQL.
 */
@Injectable()
export class CustomerAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Identifiants des clients correspondant aux critères. */
  async resoudre(criteres: CriteresAudience = {}): Promise<string[]> {
    let retenus: Set<string> | null = null;

    const croiser = (ids: string[]) => {
      const frais = new Set(ids.filter(Boolean));
      retenus =
        retenus === null
          ? frais
          : new Set([...retenus].filter((id) => frais.has(id)));
    };

    if (criteres.name_contains) {
      const clients = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          OR: [
            { first_name: { contains: criteres.name_contains, mode: 'insensitive' } },
            { last_name: { contains: criteres.name_contains, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      croiser(clients.map((c) => c.id));
    }

    if (criteres.phone_contains) {
      const clients = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE', phone: { contains: criteres.phone_contains } },
        select: { id: true },
      });
      croiser(clients.map((c) => c.id));
    }

    if (criteres.email_contains) {
      const clients = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          email: { contains: criteres.email_contains, mode: 'insensitive' },
        },
        select: { id: true },
      });
      croiser(clients.map((c) => c.id));
    }

    if (criteres.min_orders !== undefined) {
      croiser(await this.parNombreDeCommandes({ gte: criteres.min_orders }));
    }
    if (criteres.max_orders !== undefined) {
      croiser(await this.parNombreDeCommandes({ lte: criteres.max_orders }));
    }

    if (criteres.min_spent !== undefined) {
      croiser(await this.parMontantDepense({ gte: criteres.min_spent }));
    }
    if (criteres.max_spent !== undefined) {
      croiser(await this.parMontantDepense({ lte: criteres.max_spent }));
    }

    if (criteres.loyalty_level) {
      const clients = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE', loyalty_level: criteres.loyalty_level as any },
        select: { id: true },
      });
      croiser(clients.map((c) => c.id));
    }

    if (criteres.city) {
      const adresses = await this.prisma.address.findMany({
        where: {
          city: { equals: criteres.city, mode: 'insensitive' },
          customer_id: { not: null },
        },
        select: { customer_id: true },
        distinct: ['customer_id'],
      });
      croiser(adresses.map((a) => a.customer_id!).filter(Boolean));
    }

    if (criteres.min_points !== undefined || criteres.max_points !== undefined) {
      const clients = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          total_points: {
            ...(criteres.min_points !== undefined ? { gte: criteres.min_points } : {}),
            ...(criteres.max_points !== undefined ? { lte: criteres.max_points } : {}),
          },
        },
        select: { id: true },
      });
      croiser(clients.map((c) => c.id));
    }

    if (criteres.registered_after || criteres.registered_before) {
      const clients = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          created_at: {
            ...(criteres.registered_after ? { gte: new Date(criteres.registered_after) } : {}),
            ...(criteres.registered_before ? { lte: new Date(criteres.registered_before) } : {}),
          },
        },
        select: { id: true },
      });
      croiser(clients.map((c) => c.id));
    }

    if (criteres.last_order_days !== undefined) {
      const depuis = subDays(new Date(), criteres.last_order_days);
      const commandes = await this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          entity_status: 'ACTIVE',
          completed_at: { gte: depuis },
        },
        select: { customer_id: true },
        distinct: ['customer_id'],
      });
      croiser(commandes.map((o) => o.customer_id));
    }

    if (criteres.no_order_days !== undefined) {
      const depuis = subDays(new Date(), criteres.no_order_days);
      const actifs = await this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          entity_status: 'ACTIVE',
          completed_at: { gte: depuis },
        },
        select: { customer_id: true },
        distinct: ['customer_id'],
      });
      const idsActifs = new Set(actifs.map((o) => o.customer_id));
      // ⚠️ Population de référence = TOUS les clients actifs, et non les seuls
      // porteurs d'un jeton Expo comme le fait le moteur d'origine. Un client
      // inactif depuis six mois est précisément celui qu'on veut relancer, et
      // c'est souvent celui qui n'a plus l'application installée.
      const tous = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE' },
        select: { id: true },
      });
      croiser(tous.map((c) => c.id).filter((id) => !idsActifs.has(id)));
    }

    // Aucun critère : toute la base active. Là encore, sans filtre de canal.
    if (retenus === null) {
      const tous = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE' },
        select: { id: true },
      });
      return tous.map((c) => c.id);
    }

    /**
     * ⚠️ Dernier filet : seuls des clients ACTIFS sortent d'ici.
     *
     * Six critères partent de `Order` ou de `Address` et ne regardent jamais
     * `Customer.entity_status` : la ville, les bornes de commandes, les bornes
     * de dépenses, et la dernière commande. Un client supprimé qui a commandé
     * le mois dernier ressortait donc du segment « ont commandé ces 30 derniers
     * jours », devenait destinataire, échouait à la livraison, et laissait la
     * diffusion avec un compte d'échecs que rien ne pouvait résorber.
     *
     * Ce filet vaut aussi pour les critères qu'on ajoutera plus tard.
     */
    const ids = Array.from(retenus as Set<string>);
    if (ids.length === 0) return [];
    const actifs = await this.prisma.customer.findMany({
      where: { id: { in: ids }, entity_status: 'ACTIVE' },
      select: { id: true },
    });
    return actifs.map((c) => c.id);
  }

  /**
   * Parmi ces clients, ceux qui peuvent RÉELLEMENT recevoir un message.
   *
   * ⚠️ Un message s'écrit dans l'application. Un client qui ne l'a jamais
   * ouverte ne le verra donc jamais, et compter sur lui est une illusion
   * d'audience.
   *
   * Or la table `Customer` ne contient pas que des utilisateurs de
   * l'application : le tunnel d'adhésion du site en crée une ligne à chaque
   * demande de Carte Nation, le backoffice peut en créer à la main, et
   * l'acquisition en fait naître depuis les captures Glovo et Yango. Annoncer
   * « 15 563 clients » sur cette base ferait espérer une portée qui n'existe
   * pas.
   *
   * `last_login_at` est le seul signal fiable : il n'est écrit qu'à la
   * connexion depuis l'application (`auth.service`). Non nul veut dire que la
   * personne a ouvert l'application au moins une fois.
   */
  async filtrerJoignablesParMessage(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const joignables = await this.prisma.customer.findMany({
      where: {
        id: { in: ids },
        entity_status: 'ACTIVE',
        last_login_at: { not: null },
      },
      select: { id: true },
    });
    return joignables.map((c) => c.id);
  }

  /** Combien de clients pour ces critères. */
  async compter(criteres: CriteresAudience = {}): Promise<number> {
    const ids = await this.resoudre(criteres);
    return ids.length;
  }

  private async parNombreDeCommandes(borne: { gte?: number; lte?: number }) {
    const resultat = await this.prisma.order.groupBy({
      by: ['customer_id'],
      where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
      _count: { id: true },
      having: { id: { _count: borne } },
    });
    return resultat.map((r) => r.customer_id);
  }

  private async parMontantDepense(borne: { gte?: number; lte?: number }) {
    const resultat = await this.prisma.order.groupBy({
      by: ['customer_id'],
      where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
      _sum: { amount: true },
      having: { amount: { _sum: borne } },
    });
    return resultat.map((r) => r.customer_id);
  }
}
