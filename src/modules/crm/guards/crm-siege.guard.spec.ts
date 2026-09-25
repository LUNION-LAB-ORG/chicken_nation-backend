import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { User, UserRole, UserType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CrmCampaignController } from '../controllers/crm-campaign.controller';
import { CrmAccessService } from '../services/crm-access.service';
import { CrmSiegeGuard } from './crm-siege.guard';

const garde = new CrmSiegeGuard(new CrmAccessService({} as PrismaService));

const contexte = (user: Partial<User>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('CrmSiegeGuard', () => {
  it('refuse un compte de point de vente avec le message attendu', () => {
    const manager = { role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: 'r1' };
    expect(() => garde.canActivate(contexte(manager))).toThrow(ForbiddenException);
    expect(() => garde.canActivate(contexte(manager))).toThrow('Les campagnes se consultent au siège');
  });

  it('laisse passer un compte du siège', () => {
    expect(garde.canActivate(contexte({ role: UserRole.MARKETING, type: UserType.BACKOFFICE }))).toBe(true);
    expect(garde.canActivate(contexte({ role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE }))).toBe(true);
  });

  it('passe avant le garde des droits : le même message sur le rapport et les gestes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CrmCampaignController)).toEqual([
      JwtAuthGuard,
      CrmSiegeGuard,
      UserPermissionsGuard,
    ]);
  });
});
