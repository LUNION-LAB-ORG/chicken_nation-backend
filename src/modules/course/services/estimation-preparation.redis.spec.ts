/**
 * Estimation de la préparation, Redis en coupure (relecture du 25/10) : le
 * client Redis garde les commandes en file pendant la reconnexion. La
 * lecture de la statistique est bornée : passé le délai, elle est recalculée
 * depuis la base et le passage du planificateur continue.
 */
import { DELAI_CACHE_MS } from 'src/modules/maps/cache-borne.helper';

import { EstimationPreparationService } from './estimation-preparation.service';

afterEach(() => {
  jest.useRealTimers();
});

it('Redis muet : la statistique est recalculée depuis la base, sans attendre le retour de Redis', async () => {
  jest.useFakeTimers({ now: new Date('2026-10-25T12:00:00.000Z') });
  const jamais = () => new Promise<never>(() => undefined);
  const cache = { get: jest.fn(jamais), set: jest.fn(jamais) };
  const prisma = { order: { findMany: jest.fn(async () => []) } };
  const service = new EstimationPreparationService(prisma as never, cache as never, {} as never);

  let reglee = false;
  void service.statistiques('resto-1').then(() => {
    reglee = true;
  });
  await jest.advanceTimersByTimeAsync(DELAI_CACHE_MS * 3);

  expect(reglee).toBe(true);
  expect(prisma.order.findMany).toHaveBeenCalledTimes(1);
  expect(cache.set).toHaveBeenCalledTimes(1);
});
