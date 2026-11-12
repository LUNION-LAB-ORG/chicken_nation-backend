import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { USER_ROLES_KEY } from 'src/modules/auth/decorators/user-roles.decorator';
import { PaiementsController } from './paiements.controller';

/** Les trois routes du remboursement : chemin, verbe, et seulement l'administrateur et le manager. */
const proto = PaiementsController.prototype as unknown as Record<string, object>;

describe('PaiementsController : routes du remboursement', () => {
  it.each([
    ['verifierRemboursement', ':id/remboursement', RequestMethod.GET],
    ['rembourser', ':id/remboursement', RequestMethod.POST],
    ['constaterRemboursement', ':id/remboursement/constater', RequestMethod.POST],
  ])('%s : %s, administrateur et manager seulement', (methode, chemin, verbe) => {
    expect(Reflect.getMetadata(PATH_METADATA, proto[methode])).toBe(chemin);
    expect(Reflect.getMetadata(METHOD_METADATA, proto[methode])).toBe(verbe);
    expect(Reflect.getMetadata(USER_ROLES_KEY, proto[methode])).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
  });

  it("l'ancienne route qui remboursait sans vérifier n'existe plus", () => {
    expect(proto.refundPaiement).toBeUndefined();
  });
});
