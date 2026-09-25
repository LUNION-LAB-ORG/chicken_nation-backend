/**
 * Réception des callbacks HubRise : la signature est vérifiée AVANT toute
 * recherche de restaurant et tout appel à HubRise.
 *
 * Prisma, la configuration et les services de synchronisation sont simulés.
 */

import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { HubriseWebhookService } from './hubrise-webhook.service';
import type { HubriseCallbackPayload } from '../interfaces/hubrise-callback.interface';

const SECRET = 'client-secret-de-test';
const PAYLOAD = {
  resource_type: 'order',
  event_type: 'order.create',
  location_id: '3r4s3-0',
  resource_id: '5dpm9',
} as unknown as HubriseCallbackPayload;
const CORPS = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
const SIGNATURE = createHmac('sha256', SECRET).update(CORPS).digest('hex');

const monter = (o: { secret?: string; strict?: string } = {}) => {
  const prisma = {
    restaurant: {
      findFirst: jest.fn(async () => ({ hubrise_access_token: 'jeton' })),
    },
  };
  const hubriseApi = { getClientSecret: jest.fn(async () => o.secret ?? SECRET) };
  const orderSync = { syncOrderFromHubrise: jest.fn(async () => undefined) };
  const customerSync = { syncCustomerFromHubrise: jest.fn(async () => undefined) };
  const config = {
    get: jest.fn((cle: string) => (cle === 'HUBRISE_WEBHOOK_STRICT' ? o.strict : undefined)),
  };

  const service = new HubriseWebhookService(
    prisma as never,
    hubriseApi as never,
    orderSync as never,
    customerSync as never,
    config as never,
  );
  (service as unknown as { logger: unknown }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { service, prisma, orderSync };
};

describe('HubriseWebhookService.handleCallback', () => {
  it('signature valide : le callback est traité', async () => {
    const { service, prisma } = monter();
    await expect(service.handleCallback(PAYLOAD, SIGNATURE, CORPS)).resolves.toEqual({
      received: true,
    });
    expect(prisma.restaurant.findFirst).toHaveBeenCalledTimes(1);
  });

  it('signature absente : 401 avant toute recherche de restaurant', async () => {
    const { service, prisma, orderSync } = monter();
    await expect(service.handleCallback(PAYLOAD, undefined, CORPS)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.restaurant.findFirst).not.toHaveBeenCalled();
    expect(orderSync.syncOrderFromHubrise).not.toHaveBeenCalled();
  });

  it('signature d’un autre corps : 401', async () => {
    const { service, prisma } = monter();
    const autre = Buffer.from(JSON.stringify({ ...PAYLOAD, resource_id: 'autre' }), 'utf8');
    await expect(service.handleCallback(PAYLOAD, SIGNATURE, autre)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.restaurant.findFirst).not.toHaveBeenCalled();
  });

  it('toute valeur autre que "false" reste stricte', async () => {
    for (const strict of [undefined, '', 'true', 'False', 'non']) {
      const { service } = monter({ strict });
      await expect(service.handleCallback(PAYLOAD, 'f'.repeat(64), CORPS)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('soupape HUBRISE_WEBHOOK_STRICT=false : accepté et signalé', async () => {
    const { service, prisma } = monter({ strict: 'false' });
    await expect(service.handleCallback(PAYLOAD, undefined, CORPS)).resolves.toEqual({
      received: true,
    });
    expect(prisma.restaurant.findFirst).toHaveBeenCalledTimes(1);
  });

  it('corps sans location : aucun jeton cherché (Prisma ignorerait le filtre)', async () => {
    const { service, prisma, orderSync } = monter({ strict: 'false' });
    const sansLocation = { ...PAYLOAD, location_id: undefined } as unknown as HubriseCallbackPayload;
    await expect(service.handleCallback(sansLocation, undefined, CORPS)).resolves.toEqual({
      received: true,
      message: 'Location non connecté',
    });
    expect(prisma.restaurant.findFirst).not.toHaveBeenCalled();
    expect(orderSync.syncOrderFromHubrise).not.toHaveBeenCalled();
  });
});
