/**
 * Webhook KKiaPay : la clé ne bloque plus aucun restaurant (18/11).
 *
 * Avant : une clé différente passait déjà (24/09, incident ZONE 4), mais un
 * compte SANS clé enregistrée chez nous, ou une base injoignable, répondait 503
 * et le paiement attendait que KKiaPay renvoie son webhook. Désormais le webhook
 * est mis en file tout de suite pour tous, et la clé n'est comparée qu'après la
 * réponse, pour le journal.
 */
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { KkiapayController } from './kkiapay.controller';
import { KkiapayWebhookDto } from './kkiapay.type';

const ZONE4 = '7c3f1a52-9d0b-4e8a-b1c2-3d4e5f607182';
const AUTRE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const corps = (surcharge: Partial<KkiapayWebhookDto> = {}) =>
  ({
    event: 'transaction.success',
    transactionId: 'tx:AB12',
    stateData: 'ORD-261118-00001',
    amount: 4040,
    method: 'WAVE',
    ...surcharge,
  }) as unknown as KkiapayWebhookDto;

function monter(options: { secret?: string | null | Promise<string | null>; fileEnPanne?: boolean } = {}) {
  const kkiapayService = {
    getWebhookSecret: jest.fn(() =>
      options.secret instanceof Promise ? options.secret : Promise.resolve(options.secret ?? null),
    ),
  };
  const auditService = { record: jest.fn() };
  const alertes = { signaler: jest.fn() };
  const webhooksQueue = {
    add: jest.fn(options.fileEnPanne ? () => Promise.reject(new Error('Redis injoignable')) : () => Promise.resolve({})),
  };
  const controller = new KkiapayController(
    kkiapayService as never,
    {} as never,
    auditService as never,
    alertes as never,
    webhooksQueue as never,
  );

  const reponse = { statut: 0, corps: undefined as unknown };
  const res = {
    status: jest.fn((code: number) => {
      reponse.statut = code;
      return { send: (c: unknown) => { reponse.corps = c; } };
    }),
  } as unknown as Response;
  const req = { originalUrl: '/kkiapay/webhook', ip: '127.0.0.1', headers: {} } as unknown as Request;

  const recevoir = (cleRecue: string | undefined, restaurantId: string | null, body = corps()) =>
    restaurantId === null
      ? controller.handleWebhook(req, res, cleRecue as string, body)
      : controller.handleWebhookForRestaurant(req, res, cleRecue as string, body, restaurantId);

  return { recevoir, reponse, kkiapayService, webhooksQueue, auditService, alertes };
}

/** Laisse passer la comparaison de la clé, faite après la réponse. */
const apresReponse = () => new Promise((r) => setImmediate(r));

describe('Webhook KKiaPay : la clé ne bloque aucun restaurant', () => {
  let avertissements: jest.SpyInstance;
  beforeEach(() => {
    avertissements = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('aucune clé enregistrée pour le restaurant : mis en file, 200 (avant : 503)', async () => {
    const { recevoir, reponse, webhooksQueue, alertes, auditService } = monter({ secret: null });

    await recevoir('nimporte', ZONE4);
    await apresReponse();

    expect(reponse.statut).toBe(200);
    expect(webhooksQueue.add).toHaveBeenCalledWith(
      'event',
      expect.objectContaining({ transactionId: 'tx:AB12', restaurantId: ZONE4 }),
      { jobId: 'transaction.success_txAB12' },
    );
    expect(alertes.signaler).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(avertissements).toHaveBeenCalledWith(expect.stringContaining('aucune clé enregistrée'));
  });

  it('clé différente : mis en file, 200, désaccord noté au journal', async () => {
    const { recevoir, reponse, webhooksQueue } = monter({ secret: 'la-bonne-cle-du-restaurant' });

    await recevoir('une-autre-cle-collee', AUTRE);
    await apresReponse();

    expect(reponse.statut).toBe(200);
    expect(webhooksQueue.add).toHaveBeenCalledTimes(1);
    expect(avertissements).toHaveBeenCalledWith(expect.stringContaining('clé différente'));
  });

  it('pas de clé dans la requête : mis en file, 200', async () => {
    const { recevoir, reponse, webhooksQueue } = monter({ secret: 'la-bonne-cle-du-restaurant' });

    await recevoir(undefined, AUTRE);

    expect(reponse.statut).toBe(200);
    expect(webhooksQueue.add).toHaveBeenCalledTimes(1);
  });

  it('bonne clé : mis en file, 200, rien au journal', async () => {
    const { recevoir, reponse, webhooksQueue } = monter({ secret: 'la-bonne-cle-du-restaurant' });

    await recevoir('la-bonne-cle-du-restaurant', AUTRE);
    await apresReponse();

    expect(reponse.statut).toBe(200);
    expect(webhooksQueue.add).toHaveBeenCalledTimes(1);
    expect(avertissements).not.toHaveBeenCalled();
  });

  it('route globale sans clé enregistrée : mis en file, 200', async () => {
    const { recevoir, reponse, webhooksQueue } = monter({ secret: null });

    await recevoir('nimporte', null);

    expect(reponse.statut).toBe(200);
    expect(webhooksQueue.add).toHaveBeenCalledWith(
      'event',
      expect.objectContaining({ restaurantId: undefined }),
      expect.anything(),
    );
  });

  it('la réponse n’attend pas la base : 200 même si la lecture de la clé ne revient jamais', async () => {
    const { recevoir, reponse, webhooksQueue } = monter({ secret: new Promise<string | null>(() => undefined) });

    await recevoir('nimporte', ZONE4);

    expect(reponse.statut).toBe(200);
    expect(webhooksQueue.add).toHaveBeenCalledTimes(1);
  });

  it('base injoignable à la lecture de la clé : 200, aucune erreur ne remonte', async () => {
    const { recevoir, reponse } = monter({ secret: Promise.reject(new Error('P1001')) });

    await expect(recevoir('nimporte', ZONE4)).resolves.toBeUndefined();
    await apresReponse();

    expect(reponse.statut).toBe(200);
    expect(avertissements).toHaveBeenCalledWith(expect.stringContaining('clé non comparée'));
  });

  it('file d’attente injoignable : 503 pour que KKiaPay renvoie, refus journalisé et annoncé', async () => {
    const { recevoir, reponse, alertes, auditService } = monter({ secret: 'cle', fileEnPanne: true });

    await recevoir('cle', ZONE4);

    expect(reponse.statut).toBe(503);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ status_code: 503 }));
    expect(alertes.signaler).toHaveBeenCalledTimes(1);
  });

  it('adresse avec un compte qui n’est pas un identifiant de restaurant : 404, rien en file', async () => {
    const { recevoir, reponse, webhooksQueue, alertes } = monter({ secret: null });

    await recevoir('nimporte', 'pas-un-restaurant');

    expect(reponse.statut).toBe(404);
    expect(webhooksQueue.add).not.toHaveBeenCalled();
    expect(alertes.signaler).not.toHaveBeenCalled();
  });
});
