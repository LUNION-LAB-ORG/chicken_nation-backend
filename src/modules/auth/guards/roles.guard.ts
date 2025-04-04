import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const requiredRoles = this.reflector.get<string[]>('roles', context.getHandler());
    if (!requiredRoles) {
      return true;
    }
    
    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      return false;
    }
    
    console.log('User dans RolesGuard:', JSON.stringify(user));
    console.log('Rôles requis:', requiredRoles);
    
    // Vérifier si l'utilisateur a un des rôles requis
    if (user.roles && Array.isArray(user.roles)) {
      const hasRole = requiredRoles.some(role => user.roles.includes(role));
      console.log('Utilisateur a-t-il un rôle requis?', hasRole);
      if (hasRole) return true;
    }
    
    // Si l'utilisateur est admin, autoriser l'accès
    if (user.is_admin) {
      console.log('Utilisateur est admin:', user.is_admin);
      return true;
    }
    
    console.log('Accès refusé');
    return false;
  }
}