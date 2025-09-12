import { permissionsByRole, RolePermissions } from 'src/common/constantes/permissionsByRole';
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Modules } from 'src/constant/enum/module-enum';
import { UserRole } from '@prisma/client';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Récupère la permission requise depuis le décorateur
    const required = this.reflector.get<{ module: Modules; action: string }>(
      'permission',
      context.getHandler(),
    );

    if (!required) return true;

    const { module: requiredModule, action: requiredAction } = required;

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.role) throw new ForbiddenException('Utilisateur non autorisé');

    const rolePermissions: RolePermissions = permissionsByRole[user.role as UserRole];
    if (!rolePermissions) throw new ForbiddenException('Permissions non définies pour ce rôle');

    // Vérifie que le module existe dans l'enum
    if (!(Object.values(Modules) as string[]).includes(requiredModule)) {
      throw new ForbiddenException('Module inconnu');
    }

    // Vérifie exclusions
    if (rolePermissions.exclusions?.includes(requiredModule)) return false;

    // Vérifie permissions
    const modulePerms = rolePermissions.modules[requiredModule] || rolePermissions.modules[Modules.ALL];
    if (!modulePerms) return false;

    return modulePerms.includes(requiredAction);
  }
}
