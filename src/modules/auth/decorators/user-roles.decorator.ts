import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const USER_ROLES_KEY = 'user-roles';
export const UserRoles = (...roles: UserRole[]) => SetMetadata(USER_ROLES_KEY, roles);
