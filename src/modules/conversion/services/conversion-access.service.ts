import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';

/**
 * Qui voit et qui touche quoi dans le module Prospects (cahier §9).
 *
 *  - Gestionnaire (droit CREATE : direction, marketing) : tout.
 *  - Agent (droit UPDATE sans CREATE) : ses prospects, et ceux des campagnes
 *    qu'il pilote.
 *  - Lecture seule (READ ou REPORT seulement) : les tableaux de bord, jamais
 *    un téléphone ni un e-mail.
 *
 * Le garde de route vérifie déjà l'action ; ce service ajoute la portée, que
 * le rôle seul ne peut pas dire.
 */
@Injectable()
export class ConversionAccessService {
  constructor(private readonly prisma: PrismaService) {}

  peut(user: Pick<User, 'role'>, action: Action): boolean {
    const perms = permissionsByRole[user.role as UserRole];
    if (!perms || perms.exclusions?.includes(Modules.PROSPECTS)) return false;
    const actions = perms.modules[Modules.PROSPECTS] ?? perms.modules[Modules.ALL];
    return !!actions?.includes(action);
  }

  estGestionnaire(user: Pick<User, 'role'>): boolean {
    return this.peut(user, Action.CREATE);
  }

  /** Rôles qui peuvent recevoir des prospects à traiter. */
  rolesAgents(): UserRole[] {
    return (Object.keys(permissionsByRole) as UserRole[]).filter((role) =>
      this.peut({ role }, Action.UPDATE),
    );
  }

  /** Filtre des prospects visibles par cet utilisateur. */
  portee(user: User): Prisma.ConversionProspectWhereInput {
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
    prospect: { assigned_to_id: string | null; campaign_id: string | null },
  ): Promise<void> {
    if (this.estGestionnaire(user)) return;
    if (!this.peut(user, Action.UPDATE)) {
      throw new ForbiddenException('Votre accès se limite aux tableaux de bord');
    }
    if (prospect.assigned_to_id === user.id) return;
    if (prospect.campaign_id && (await this.estPilote(user, prospect.campaign_id))) return;
    throw new ForbiddenException("Ce prospect n'est pas dans votre portefeuille");
  }

  async estPilote(user: User, campaignId: string): Promise<boolean> {
    const campagne = await this.prisma.conversionCampaign.findUnique({
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
