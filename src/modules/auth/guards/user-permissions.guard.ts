import { permissionsByRole, RolePermissions } from 'src/modules/auth/constantes/permissionsByRole';
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { UserRole } from '@prisma/client';

type Requis = { module: Modules; action: string };

@Injectable()
export class UserPermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    // Une permission, ou plusieurs dont UNE SEULE suffit (RequireUnePermission).
    const required = this.reflector.get<Requis | Requis[]>(
      'permission',
      context.getHandler(),
    );

    if (!required) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.role) throw new ForbiddenException('Utilisateur non autorisé');

    const rolePermissions: RolePermissions = permissionsByRole[user.role as UserRole];
    if (!rolePermissions) throw new ForbiddenException('Permissions non définies pour ce rôle');

    const attendues = Array.isArray(required) ? required : [required];
    return attendues.some((r) => this.accorde(rolePermissions, r));
  }

  /**
   * Une permission est-elle accordée à ce rôle ? Renvoie un booléen plutôt que
   * de lever : avec une alternative, un refus sur la première ne doit pas
   * empêcher d'examiner la seconde.
   */
  private accorde(perms: RolePermissions, { module, action }: Requis): boolean {
    if (!(Object.values(Modules) as string[]).includes(module)) return false;
    if (perms.exclusions?.includes(module)) return false;
    const modulePerms = perms.modules[module] || perms.modules[Modules.ALL];
    if (!modulePerms) return false;
    return modulePerms.includes(action);
  }
}
