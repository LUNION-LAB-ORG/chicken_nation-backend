import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { CrmSegment, CrmStatus, EntityStatus, Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { STATUTS_OUVERTS } from '../crm.rules';

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
 * Qui voit et qui touche quoi dans le CRM (cahier §9).
 *
 *  - Gestionnaire (droit CREATE : direction, marketing) : tout.
 *  - Agent (droit UPDATE sans CREATE) : ses contacts, ceux des campagnes qu'il
 *    pilote, et la file commune Glovo/Yango (captés avant aujourd'hui, ouverts,
 *    confiés à personne, hors campagne) : le premier qui compose prend le
 *    contact. Il peut aussi consulter une fiche trouvée par son numéro exact.
 *  - Consultation (READ ou REPORT seulement) : les tableaux de bord, jamais un
 *    téléphone ni un e-mail.
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

  /** Rôles qui peuvent recevoir des contacts à traiter. */
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

  /** Filtre des contacts qu'un utilisateur voit dans ses listes. */
  portee(user: User): Prisma.CrmContactWhereInput {
    if (this.estGestionnaire(user)) return {};
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
