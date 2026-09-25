import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
import { MESSAGE_COMPTE_DESACTIVE } from '../helpers/staff-account-status.helper';

const ID = '11111111-1111-4111-8111-111111111111';

function prismaAvec(entity_status: EntityStatus | null) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(entity_status ? { id: ID, password: 'haché', entity_status } : null);
  return { user: { findUnique } } as unknown as PrismaService;
}

const config = { get: () => 'secret-de-test' } as unknown as ConfigService;

const strategies = [
  ['JwtStrategy', (p: PrismaService) => new JwtStrategy(config, p)],
  ['JwtRefreshStrategy', (p: PrismaService) => new JwtRefreshStrategy(config, p)],
] as const;

describe.each(strategies)('%s.validate, statut du compte', (_nom, fabriquer) => {
  it.each([EntityStatus.NEW, EntityStatus.ACTIVE])(
    'accepte un compte %s et retire le mot de passe',
    async (statut) => {
      const user = await fabriquer(prismaAvec(statut)).validate({ sub: ID });
      expect(user).toMatchObject({ id: ID, entity_status: statut });
      expect(user).not.toHaveProperty('password');
    },
  );

  it.each([EntityStatus.INACTIVE, EntityStatus.DELETED])(
    'refuse un compte %s (401, message en français)',
    async (statut) => {
      const promesse = fabriquer(prismaAvec(statut)).validate({ sub: ID });
      await expect(promesse).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(fabriquer(prismaAvec(statut)).validate({ sub: ID })).rejects.toThrow(
        MESSAGE_COMPTE_DESACTIVE,
      );
    },
  );

  it('refuse un utilisateur introuvable, comme avant', async () => {
    await expect(fabriquer(prismaAvec(null)).validate({ sub: ID })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
