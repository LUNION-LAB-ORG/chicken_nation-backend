import { permissionsByRole, RolePermissions } from 'src/constant/permissionsByRole';
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UserRole } from '@prisma/client';


@Injectable()
export class ModulePermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<{ module: string; action: string }>(
      'permission',
      context.getHandler(),
    );

    if (!required) return true;

    const { module: requiredModule, action: requiredAction } = required;

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.role) throw new ForbiddenException('Utilisateur non autorisé');

    const rolePermissions: RolePermissions = permissionsByRole[user.role as UserRole];
    if (!rolePermissions) throw new ForbiddenException('Permissions non définies pour ce rôle');

    // Vérifie exclusions
    if (rolePermissions.exclusions?.includes(requiredModule)) return false;

    // Vérifie permissions
    const modulePerms = rolePermissions.modules[requiredModule] || rolePermissions.modules['all'];
    if (!modulePerms) return false;

    return modulePerms.includes(requiredAction);
  }
}

