import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { KkiapayService, MESSAGE_COMPTE_DECONFIGURE } from './kkiapay.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Vérification et remboursement auprès du compte qui a encaissé (12/11).
 * Aucun appel réseau : le client HTTP du compte est simulé.
 */
function monter(post: jest.Mock, compte: string | null = 'r-1') {
  const service = new KkiapayService({} as any, {} as any, {} as any);
  jest.spyOn(service, 'resolveAccount').mockImplementation(async () => ({
    restaurantId: compte,
    http: { post } as any,
    publicKey: 'pk',
    sandbox: true,
    expiresAt: Date.now() + 60_000,
  }));
  return service;
}

const erreurHttp = (status: number, data: unknown) => Object.assign(new Error('http'), { response: { status, data } });

describe('KKiaPay : compte encaisseur strict', () => {
  it('un compte de restaurant qui n’est plus configuré est refusé, sans appel', async () => {
    const post = jest.fn();
    const service = monter(post, null);
    await expect(service.rembourserTransaction('t-1', 'r-1')).rejects.toThrow(MESSAGE_COMPTE_DECONFIGURE);
    await expect(service.lireSurCompteEncaisseur('t-1', 'r-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('le compte global sert les paiements sans restaurant tracé', async () => {
    const post = jest.fn(async () => ({ data: { status: 'SUCCESS' } }));
    const service = monter(post, null);
    await expect(service.lireSurCompteEncaisseur('t-1', null)).resolves.toEqual({ status: 'SUCCESS' });
  });
});

describe('KKiaPay : lecture d’une transaction', () => {
  it('inconnue de ce compte : null ; KKiaPay injoignable : erreur, jamais « inconnue »', async () => {
    expect(await monter(jest.fn(async () => { throw erreurHttp(404, {}); })).lireSurCompteEncaisseur('t-1', 'r-1')).toBeNull();
    await expect(monter(jest.fn(async () => { throw new Error('timeout'); })).lireSurCompteEncaisseur('t-1', 'r-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(monter(jest.fn(async () => { throw erreurHttp(502, {}); })).lireSurCompteEncaisseur('t-1', 'r-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('KKiaPay : issue d’un remboursement', () => {
  it('réponse 2xx : remboursé, sur la bonne route', async () => {
    const post = jest.fn(async () => ({ data: { transactionId: 't-1', status: 'REVERTED' } }));
    const issue = await monter(post).rembourserTransaction('t-1', 'r-1');
    expect(post).toHaveBeenCalledWith('/api/v1/transactions/revert', { transactionId: 't-1' });
    expect(issue).toEqual({ issue: 'REMBOURSE', reponse: { transactionId: 't-1', status: 'REVERTED' } });
  });

  it('réponse 2xx qui annonce un échec : refusé, avec la raison', async () => {
    const issue = await monter(jest.fn(async () => ({ data: { status: 'FAILED', failureCode: 'X', failureMessage: 'Solde insuffisant' } }))).rembourserTransaction('t-1', 'r-1');
    expect(issue).toEqual({ issue: 'REFUSE', code: 'X', raison: 'Solde insuffisant' });
  });

  it('refus 4xx : le code et la raison de KKiaPay', async () => {
    const issue = await monter(jest.fn(async () => { throw erreurHttp(400, { code: 'TRANSACTION_NOT_ELIGIBLE', reason: 'already reverted' }); })).rembourserTransaction('t-1', 'r-1');
    expect(issue).toEqual({ issue: 'REFUSE', code: 'TRANSACTION_NOT_ELIGIBLE', raison: 'already reverted' });
  });

  it('pas de réponse, ou erreur de son côté : incertain, l’argent est peut-être parti', async () => {
    expect(await monter(jest.fn(async () => { throw new Error('timeout'); })).rembourserTransaction('t-1', 'r-1')).toEqual({ issue: 'INCERTAIN' });
    expect(await monter(jest.fn(async () => { throw erreurHttp(503, {}); })).rembourserTransaction('t-1', 'r-1')).toEqual({ issue: 'INCERTAIN' });
  });
});
