import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';

/**
 * Qui voit et qui touche quoi dans le module Contacts (cahier §9).
 *
 *  - Gestionnaire (droit CREATE : direction, marketing) : tout.
 *  - Agent (droit UPDATE sans CREATE) : ses contacts, et ceux des campagnes
 *    qu'il pilote.
 *  - Lecture seule (READ ou REPORT seulement) : les tableaux de bord, jamais
 *    un téléphone ni un e-mail.
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

  /** Filtre des contacts visibles par cet utilisateur. */
  portee(user: User): Prisma.CrmContactWhereInput {
    if (this.estGestionnaire(user)) return {};
    if (!this.peut(user, Action.UPDATE)) {
      throw new ForbiddenException('Votre accès se limite aux tableaux de bord');
    }
    return {
      OR: [{ assigned_to_id: user.id }, { campaign: { lead_agent_id: user.id } }],
    };
  }

  async assertPeutTraiter(
    user: User,
    contact: { assigned_to_id: string | null; campaign_id: string | null },
  ): Promise<void> {
    if (this.estGestionnaire(user)) return;
    if (!this.peut(user, Action.UPDATE)) {
      throw new ForbiddenException('Votre accès se limite aux tableaux de bord');
    }
    if (contact.assigned_to_id === user.id) return;
    if (contact.campaign_id && (await this.estPilote(user, contact.campaign_id))) return;
    throw new ForbiddenException("Ce contact n'est pas dans votre portefeuille");
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
