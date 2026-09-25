import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { CrmSegment, CrmStatus, EntityStatus, Prisma, User, UserRole, UserType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { resolveRestaurantScope } from 'src/modules/order/helpers/restaurant-scope.helper';
import { STATUTS_OUVERTS, ficheDuRestaurant } from '../crm.rules';
import type { Perimetre } from './crm-passages.query';

type Client = Prisma.TransactionClient | PrismaService;

/** Ce qu'il faut savoir d'un contact pour décider qui peut le traiter. */
export interface ContactPortee {
  id: string;
  assigned_to_id: string | null;
  campaign_id: string | null;
  segment: CrmSegment;
  status: CrmStatus;
  segment_since: Date;
}

export const PUBLICS_FILE_COMMUNE: CrmSegment[] = [CrmSegment.GLOVO, CrmSegment.YANGO];

/** Début du jour en UTC : la Côte d'Ivoire vit à UTC+0, sans heure d'été. */
export const debutDuJour = (d = new Date()) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

/**
 * Qui voit et qui touche quoi dans le CRM (cahier §9, revu le 25/09).
 *
 *  - Gestionnaire (droit CREATE : direction) : tout.
 *  - Agent (droit UPDATE sans CREATE) : ses contacts, ceux des campagnes qu'il
 *    pilote, et la file commune Glovo/Yango (captés avant aujourd'hui, ouverts,
 *    confiés à personne, hors campagne) : le premier qui compose prend le
 *    contact. Il peut aussi consulter une fiche trouvée par son numéro exact.
 *  - Lecteur (droit READ sans UPDATE ni CREATE : marketing, manager) : la
 *    consultation. Il voit la liste des contacts et les fiches, téléphone
 *    compris (fiche en mode « consultation »), les campagnes, coupons, ventes,
 *    réglages et, avec REPORT, les tableaux de bord ; il ne fait aucun geste
 *    (appel, coupon, assignation, pilotage) et n'exporte rien : les routes
 *    d'écriture exigent UPDATE, CREATE ou DELETE, les exports EXPORT.
 *  - REPORT sans READ : les tableaux de bord seulement.
 *
 * Compte de point de vente (User.type RESTAURANT, le manager) : tout ce qui
 * précède, limité aux fiches de SON restaurant (`ficheDuRestaurant`), pris du
 * compte et jamais d'un paramètre ; sans restaurant rattaché, aucune fiche.
 * Les campagnes se consultent au siège.
 *
 * Le garde de route vérifie déjà l'action ; ce service ajoute la portée, que
 * le rôle seul ne peut pas dire.
 */
@Injectable()
export class CrmAccessService {
  constructor(private readonly prisma: PrismaService) {}

  peut(user: Pick<User, 'role'>, action: Action): boolean {
    const perms = permissionsByRole[user.role as UserRole];
    if (!perms || perms.exclusions?.includes(Modules.CRM)) return false;
    const actions = perms.modules[Modules.CRM] ?? perms.modules[Modules.ALL];
    return !!actions?.includes(action);
  }

  estGestionnaire(user: Pick<User, 'role'>): boolean {
    return this.peut(user, Action.CREATE);
  }

  /** Consultation : lire le CRM, téléphones compris, sans aucun geste. */
  estLecteur(user: Pick<User, 'role'>): boolean {
    return this.peut(user, Action.READ) && !this.peut(user, Action.UPDATE) && !this.peut(user, Action.CREATE);
  }

  /**
   * Restaurant d'un compte de point de vente, pris du compte, jamais d'un
   * paramètre. Sans restaurant rattaché : un id qui n'existe pas, donc
   * aucune fiche. `undefined` : compte du siège, tout le réseau.
   */
  restaurantDe(user: Pick<User, 'type' | 'restaurant_id'>): string | undefined {
    return resolveRestaurantScope(user as User);
  }

  /**
   * Filtres d'un tableau de bord avec le périmètre du compte, posé ici et
   * jamais lu dans la requête. Un compte de point de vente ne compte que les
   * fiches de son restaurant, sans filtre de campagne : les campagnes se
   * consultent au siège.
   */
  filtresAnalyse<T extends object>(user: User, q: T): T & Perimetre {
    const restaurant = this.restaurantDe(user);
    if (restaurant === undefined) return { ...q, perimetre_restaurant: undefined };
    return { ...q, campaign_id: undefined, perimetre_restaurant: restaurant };
  }

  /** Une fiche d'un autre restaurant, ouverte par un compte de point de vente : refusée. */
  async assertDuRestaurant(user: User, contactId: string): Promise<void> {
    const restaurant = this.restaurantDe(user);
    if (restaurant === undefined) return;
    const rattachee = await this.prisma.crmContact.count({
      where: { AND: [{ id: contactId }, ficheDuRestaurant(restaurant)] },
    });
    if (rattachee === 0) throw new ForbiddenException("Ce client n'est pas rattaché à votre restaurant");
  }

  /** Campagnes (liste, détail, statistiques, comparatif, rapport, gestes) : jamais depuis un point de vente. */
  assertSiege(user: Pick<User, 'type'> | undefined): void {
    if (user?.type === UserType.RESTAURANT) throw new ForbiddenException('Les campagnes se consultent au siège');
  }

  /** Rôles qui peuvent recevoir des contacts à traiter (droit UPDATE). */
  rolesAgents(): UserRole[] {
    return (Object.keys(permissionsByRole) as UserRole[]).filter((role) =>
      this.peut({ role }, Action.UPDATE),
    );
  }

  /** La file commune Glovo/Yango du jour (J+1). */
  fileCommune(maintenant = new Date()): Prisma.CrmContactWhereInput {
    return {
      segment: { in: PUBLICS_FILE_COMMUNE },
      status: { in: STATUTS_OUVERTS },
      assigned_to_id: null,
      campaign_id: null,
      segment_since: { lt: debutDuJour(maintenant) },
      entity_status: { not: EntityStatus.DELETED },
    };
  }

  dansFileCommune(c: ContactPortee, maintenant = new Date()): boolean {
    return (
      PUBLICS_FILE_COMMUNE.includes(c.segment) &&
      STATUTS_OUVERTS.includes(c.status) &&
      !c.assigned_to_id &&
      !c.campaign_id &&
      c.segment_since < debutDuJour(maintenant)
    );
  }

  /**
   * Filtre des contacts qu'un utilisateur voit dans ses listes : tout pour la
   * direction et la consultation, son portefeuille pour un agent ; limité aux
   * fiches de son restaurant pour un compte de point de vente.
   */
  portee(user: User): Prisma.CrmContactWhereInput {
    const role = this.porteeRole(user);
    const restaurant = this.restaurantDe(user);
    return restaurant === undefined ? role : { AND: [role, ficheDuRestaurant(restaurant)] };
  }

  private porteeRole(user: User): Prisma.CrmContactWhereInput {
    if (this.estGestionnaire(user) || this.estLecteur(user)) return {};
    this.assertAgent(user);
    return {
      OR: [{ assigned_to_id: user.id }, { campaign: { lead_agent_id: user.id } }, this.fileCommune()],
    };
  }

  assertAgent(user: User): void {
    if (!this.peut(user, Action.UPDATE)) {
      throw new ForbiddenException('Votre accès se limite aux tableaux de bord');
    }
  }

  /**
   * Peut-il agir sur ce contact ? Renvoie « commune » quand le contact est pris
   * dans la file commune : l'action devra le lui assigner (voir `prendre`).
   */
  async assertPeutTraiter(user: User, contact: ContactPortee): Promise<'gestion' | 'sien' | 'commune'> {
    // Un compte de point de vente n'agit jamais hors de son restaurant.
    await this.assertDuRestaurant(user, contact.id);
    if (this.estGestionnaire(user)) return 'gestion';
    this.assertAgent(user);
    if (contact.assigned_to_id === user.id) return 'sien';
    if (contact.campaign_id && (await this.estPilote(user, contact.campaign_id))) return 'sien';
    if (this.dansFileCommune(contact)) return 'commune';
    // Pris par un collègue (souvent pendant que l'écran de l'agent était ouvert) :
    // un conflit, pas un refus de droits. Le message lui dit qui s'en occupe.
    if (contact.assigned_to_id) throw new ConflictException(await this.messagePris(contact.assigned_to_id));
    throw new ForbiddenException("Ce contact n'est pas dans votre portefeuille");
  }

  /**
   * Prise atomique, DANS la transaction d'écriture : un contact de la file
   * commune devient celui de qui agit, sauf si un collègue l'a pris
   * entre-temps (409, sa saisie reste à l'écran). Un gestionnaire qui appelle
   * un client de la file le prend aussi (sinon un agent le rappellerait),
   * mais il agit sur le client d'un collègue sans le lui retirer.
   */
  async prendre(tx: Client, user: User, contactId: string, maintenant = new Date()): Promise<boolean> {
    const pris = await tx.crmContact.updateMany({
      where: { id: contactId, ...this.fileCommune(maintenant) },
      data: { assigned_to_id: user.id, assigned_at: maintenant },
    });
    if (pris.count > 0) return true;
    if (this.estGestionnaire(user)) return false;
    const contact = await tx.crmContact.findUnique({
      where: { id: contactId },
      select: { assigned_to_id: true, campaign_id: true, status: true },
    });
    if (!contact || contact.status === CrmStatus.CONVERTI) return false;
    if (contact.assigned_to_id === user.id) return false;
    if (contact.campaign_id && (await this.estPilote(user, contact.campaign_id))) return false;
    throw new ConflictException(
      contact.assigned_to_id ? await this.messagePris(contact.assigned_to_id) : "Ce contact n'est plus dans la file commune",
    );
  }

  /** Condition « c'est bien le sien » ajoutée aux prises de statut d'un agent. */
  conditionAgent(user: User): Prisma.CrmContactWhereInput {
    if (this.estGestionnaire(user)) return {};
    return { OR: [{ assigned_to_id: user.id }, { campaign: { lead_agent_id: user.id } }] };
  }

  async messagePris(agentId: string): Promise<string> {
    const agent = await this.prisma.user.findUnique({ where: { id: agentId }, select: { fullname: true } });
    return `Déjà pris par ${agent?.fullname ?? 'un collègue'}`;
  }

  async estPilote(user: User, campaignId: string): Promise<boolean> {
    const campagne = await this.prisma.crmCampaign.findUnique({
      where: { id: campaignId },
      select: { lead_agent_id: true },
    });
    return campagne?.lead_agent_id === user.id;
  }

  async assertGestionnaireOuPilote(user: User, campaignId: string): Promise<void> {
    if (this.estGestionnaire(user)) return;
    if (this.peut(user, Action.UPDATE) && (await this.estPilote(user, campaignId))) return;
    throw new ForbiddenException('Réservé à la direction et au pilote de la campagne');
  }
}
