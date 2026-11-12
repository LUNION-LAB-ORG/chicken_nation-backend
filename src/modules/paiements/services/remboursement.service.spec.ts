import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { User } from '@prisma/client';
import { RemboursementService, CODE_REMBOURSEE_CHEZ_KKIAPAY } from './remboursement.service';
import { MESSAGE_EN_COURS, MESSAGE_INCERTAIN, MESSAGE_MANUEL } from '../helpers/remboursement.rules';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAINTENANT = new Date('2026-11-12T10:00:00.000Z');
const allerRetour = () => Promise.resolve();

const admin = { id: 'u-admin', role: 'ADMIN', type: 'BACKOFFICE', restaurant_id: null, fullname: 'Koffi Admin' } as unknown as User;
const manager = { id: 'u-man', role: 'MANAGER', type: 'RESTAURANT', restaurant_id: 'r-1', fullname: 'Mariam Manager' } as unknown as User;
const managerAilleurs = { ...manager, id: 'u-man2', restaurant_id: 'r-2' } as unknown as User;
const caissier = { id: 'u-c', role: 'CAISSIER', type: 'RESTAURANT', restaurant_id: 'r-1', fullname: 'Caisse' } as unknown as User;

/** Une table de paiements en mémoire : updateMany conditionné = vraie revendication. */
function monter(p: Record<string, any> = {}, kkiapay: Record<string, any> = {}) {
  const ligne: Record<string, any> = {
    id: 'p-1',
    reference: '459100796371',
    amount: 6060,
    fees: 116,
    total: 6176,
    mode: 'WALLET',
    source: 'wave',
    status: 'SUCCESS',
    created_at: new Date('2026-11-12T00:13:00.000Z'),
    restaurant_id: 'r-1',
    order_id: 'o-1',
    rembourse_at: null,
    rembourse_par_nom: null,
    rembourse_par_id: null,
    remboursement_demande_at: null,
    order: { id: 'o-1', reference: 'ORD-261111-55490', restaurant_id: 'r-1' },
    ...p,
  };
  const correspond = (where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((w: any) => correspond(w));
      if (v && typeof v === 'object' && !(v instanceof Date) && 'lt' in v) return ligne[k] instanceof Date && ligne[k] < v.lt;
      if (v instanceof Date) return ligne[k] instanceof Date && ligne[k].getTime() === v.getTime();
      return ligne[k] === v;
    });
  const prisma = {
    paiement: {
      findUnique: jest.fn(async () => {
        await allerRetour();
        return { ...ligne };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        await allerRetour();
        if (!correspond(where)) return { count: 0 };
        Object.assign(ligne, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => {
        await allerRetour();
        Object.assign(ligne, data);
        return { id: ligne.id, status: ligne.status, rembourse_at: ligne.rembourse_at, rembourse_par_nom: ligne.rembourse_par_nom };
      }),
    },
    restaurant: { findUnique: jest.fn(async () => ({ name: 'Angré' })) },
    order: { findUnique: jest.fn(async () => ({ paied: false })) },
  };
  const k = {
    lireSurCompteEncaisseur: jest.fn(async () => ({ status: 'SUCCESS', amount: 6060, fees: 116, source_common_name: 'Wave', performedAt: '2026-11-12T00:13:00Z' })),
    rembourserTransaction: jest.fn(async () => ({ issue: 'REMBOURSE', reponse: { status: 'REVERTED' } })),
    ...kkiapay,
  };
  const paiements = { recomputeOrderPaiedFlag: jest.fn(async () => undefined) };
  const evenement = { paiementAnnule: jest.fn() };
  const service = new RemboursementService(prisma as any, k as any, paiements as any, evenement as any);
  return { service, ligne, prisma, k, paiements, evenement };
}

const refus = async (geste: Promise<unknown>) => {
  try {
    await geste;
  } catch (e) {
    const err = e as HttpException;
    const r = err.getResponse?.();
    return { statut: err.getStatus?.(), message: typeof r === 'string' ? r : (r as any)?.message, corps: r as any };
  }
  throw new Error('aurait dû être refusé');
};

describe('remboursement : vérification', () => {
  it('dit ce que KKiaPay sait de la transaction, et que le remboursement est possible', async () => {
    const { service, k } = monter();
    const v = await service.verifier('p-1', admin);
    expect(k.lireSurCompteEncaisseur).toHaveBeenCalledWith('459100796371', 'r-1');
    expect(v).toMatchObject({
      paiement: { reference: '459100796371', montant: 6060, frais: 116, total: 6176, moyen: 'wave', statut: 'SUCCESS' },
      commande: { reference: 'ORD-261111-55490' },
      kkiapay: { statut: 'SUCCESS', libelle: 'Payée', montant: 6060, frais: 116, moyen: 'Wave' },
      compte: 'Compte du restaurant Angré',
      remboursable: true,
      constatable: false,
      raison: null,
    });
  });

  it("un encaissement saisi à la main n'interroge pas KKiaPay", async () => {
    const { service, k } = monter({ reference: 'PAY-1762900000000-12', mode: 'MOBILE_MONEY' });
    const v = await service.verifier('p-1', admin);
    expect(v).toMatchObject({ remboursable: false, raison: MESSAGE_MANUEL, kkiapay: null });
    expect(k.lireSurCompteEncaisseur).not.toHaveBeenCalled();
  });

  it('compte global pour un paiement sans restaurant tracé', async () => {
    const { service } = monter({ restaurant_id: null });
    expect((await service.verifier('p-1', admin)).compte).toBe('Compte global');
  });

  it('droits : le manager de la commande oui ; un autre manager, le caissier non', async () => {
    const { service } = monter();
    expect((await service.verifier('p-1', manager)).remboursable).toBe(true);
    await expect(service.verifier('p-1', managerAilleurs)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.verifier('p-1', caissier)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('KKiaPay injoignable : un message lisible, rien de cassé', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const { service } = monter({}, { lireSurCompteEncaisseur: jest.fn(async () => { throw new ServiceUnavailableException('KKiaPay injoignable (verify)'); }) });
    const r = await refus(service.verifier('p-1', admin));
    expect(r).toMatchObject({ statut: 503, message: 'KKiaPay ne répond pas. Réessayez dans un instant.' });
  });
});

describe('remboursement : rembourser', () => {
  it('revérifie, rembourse, puis note qui et quand ; la commande est recalculée', async () => {
    const { service, ligne, k, paiements, evenement } = monter();
    const r = await service.rembourser('p-1', { reference: '459100796371' }, manager, MAINTENANT);
    expect(k.lireSurCompteEncaisseur).toHaveBeenCalledTimes(1);
    expect(k.rembourserTransaction).toHaveBeenCalledWith('459100796371', 'r-1');
    expect(r).toEqual({
      message: 'Remboursement de 6 060 F effectué.',
      paiement: { id: 'p-1', status: 'REVERTED', rembourse_at: MAINTENANT, rembourse_par_nom: 'Mariam Manager' },
      commande_payee: false,
    });
    expect(ligne).toMatchObject({ status: 'REVERTED', rembourse_par_id: 'u-man', remboursement_demande_at: null });
    expect(paiements.recomputeOrderPaiedFlag).toHaveBeenCalledWith('o-1');
    expect(evenement.paiementAnnule).toHaveBeenCalled();
  });

  it('la référence vue à l’écran a changé : refus, rien ne part', async () => {
    const { service, k } = monter();
    expect((await refus(service.rembourser('p-1', { reference: 'autre' }, admin, MAINTENANT))).statut).toBe(409);
    expect(k.rembourserTransaction).not.toHaveBeenCalled();
  });

  it('deux clics ensemble : un seul remboursement part', async () => {
    const { service, k } = monter();
    const resultats = await Promise.allSettled([
      service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT),
      service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT),
    ]);
    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejet = resultats.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejet.reason).toBeInstanceOf(ConflictException);
    expect(k.rembourserTransaction).toHaveBeenCalledTimes(1);
  });

  it('une demande en cours bloque ; restée en plan plus de deux minutes, elle ne bloque plus', async () => {
    const recente = monter({ remboursement_demande_at: new Date(MAINTENANT.getTime() - 30_000) });
    expect(await refus(recente.service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT))).toMatchObject({
      statut: 409,
      message: MESSAGE_EN_COURS,
    });
    const ancienne = monter({ remboursement_demande_at: new Date(MAINTENANT.getTime() - 3 * 60_000) });
    await ancienne.service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT);
    expect(ancienne.ligne.status).toBe('REVERTED');
  });

  it('KKiaPay refuse : son motif en mots, le paiement reste réussi et la demande est rendue', async () => {
    const { service, ligne } = monter({}, { rembourserTransaction: jest.fn(async () => ({ issue: 'REFUSE', code: 'TRANSACTION_NOT_ELIGIBLE', raison: null })) });
    const r = await refus(service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT));
    expect(r.statut).toBe(400);
    expect(r.message).toContain('déjà remboursée ou ne peut pas l’être');
    expect(ligne).toMatchObject({ status: 'SUCCESS', remboursement_demande_at: null, rembourse_at: null });
  });

  it('pas de réponse claire : rien n’est marqué, on fait revérifier', async () => {
    const { service, ligne } = monter({}, { rembourserTransaction: jest.fn(async () => ({ issue: 'INCERTAIN' })) });
    const r = await refus(service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT));
    expect(r).toMatchObject({ statut: 502, message: MESSAGE_INCERTAIN });
    expect(ligne).toMatchObject({ status: 'SUCCESS', remboursement_demande_at: null });
  });

  it('montant différent chez KKiaPay : bloqué avant de demander quoi que ce soit', async () => {
    const { service, k } = monter({}, { lireSurCompteEncaisseur: jest.fn(async () => ({ status: 'SUCCESS', amount: 15000 })) });
    expect((await refus(service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT))).statut).toBe(400);
    expect(k.rembourserTransaction).not.toHaveBeenCalled();
  });

  it('déjà remboursée chez KKiaPay : on propose de l’enregistrer, sans redemander', async () => {
    const { service, k } = monter({}, { lireSurCompteEncaisseur: jest.fn(async () => ({ status: 'REVERTED', amount: 6060 })) });
    const r = await refus(service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT));
    expect(r).toMatchObject({ statut: 409, corps: { code: CODE_REMBOURSEE_CHEZ_KKIAPAY } });
    expect(k.rembourserTransaction).not.toHaveBeenCalled();
  });

  it('un paiement déjà remboursé ou un encaissement manuel ne se rembourse pas', async () => {
    expect((await refus(monter({ status: 'REVERTED' }).service.rembourser('p-1', { reference: '459100796371' }, admin, MAINTENANT))).statut).toBe(409);
    expect(
      (await refus(monter({ reference: 'PAY-1-2', mode: 'CASH' }).service.rembourser('p-1', { reference: 'PAY-1-2' }, admin, MAINTENANT))).statut,
    ).toBe(400);
  });
});

describe('remboursement : enregistrer un remboursement déjà fait chez KKiaPay', () => {
  it('KKiaPay le dit remboursé : noté chez nous, sans rien lui redemander', async () => {
    const { service, ligne, k } = monter({}, { lireSurCompteEncaisseur: jest.fn(async () => ({ status: 'REVERTED', amount: 6060 })) });
    const r = await service.constater('p-1', { reference: '459100796371' }, admin, MAINTENANT);
    expect(r.message).toBe('Remboursement enregistré.');
    expect(ligne).toMatchObject({ status: 'REVERTED', rembourse_par_nom: 'Koffi Admin' });
    expect(k.rembourserTransaction).not.toHaveBeenCalled();
  });

  it('KKiaPay le dit encore payé : refus, la demande est rendue', async () => {
    const { service, ligne } = monter();
    expect((await refus(service.constater('p-1', { reference: '459100796371' }, admin, MAINTENANT))).statut).toBe(409);
    expect(ligne).toMatchObject({ status: 'SUCCESS', remboursement_demande_at: null });
  });
});
