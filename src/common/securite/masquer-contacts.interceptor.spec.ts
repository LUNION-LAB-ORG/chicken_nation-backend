import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';
import { MasquerContactsInterceptor } from './masquer-contacts.interceptor';
import { SANS_MASQUAGE } from './sans-masquage.decorator';

type Reponse = { phone: string; email: string };
const FICHE: Reponse = { phone: '+2250140735992', email: 'monemailpro2007@gmail.com' };

function contexte(role: UserRole | undefined, type: 'http' | 'ws' = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => function handler() { },
    getClass: () => class Controleur { },
    switchToHttp: () => ({ getRequest: () => (role ? { user: { role } } : {}) }),
  } as unknown as ExecutionContext;
}

const suite = (donnees: unknown): CallHandler => ({ handle: () => of(donnees) });

/** Reflector qui répond toujours la même dispense. */
function reflector(dispense: boolean): Reflector {
  return { getAllAndOverride: () => dispense } as unknown as Reflector;
}

describe('MasquerContactsInterceptor', () => {
  it('masque pour le marketing', async () => {
    const i = new MasquerContactsInterceptor(reflector(false));
    const r = (await lastValueFrom(i.intercept(contexte(UserRole.MARKETING), suite(FICHE)))) as Reponse;
    expect(r.phone).toBe('+225••••••••92');
    expect(r.email).toBe('mon•••@gmail.com');
  });

  /**
   * Le test qui garde le call center au travail. Masquer un rôle de trop est
   * une panne silencieuse : l'agent lit des points et ne peut plus rappeler.
   */
  it('ne touche à rien pour tout autre rôle, ceux à venir compris', async () => {
    const i = new MasquerContactsInterceptor(reflector(false));
    const autres = Object.values(UserRole).filter((r) => r !== UserRole.MARKETING);
    expect(autres.length).toBeGreaterThan(0);
    for (const role of autres) {
      const r = (await lastValueFrom(i.intercept(contexte(role), suite(FICHE)))) as Reponse;
      expect(r).toEqual(FICHE);
    }
  });

  it('ne touche à rien pour un client ou un livreur, qui n’ont pas de rôle de personnel', async () => {
    const i = new MasquerContactsInterceptor(reflector(false));
    const r = await lastValueFrom(i.intercept(contexte(undefined), suite(FICHE)));
    expect(r).toEqual(FICHE);
  });

  /**
   * @SansMasquage() couvre la fiche du compte de l'agent, qui se MODIFIE :
   * masquer là écrirait les pointillés en base au premier enregistrement.
   */
  it('respecte @SansMasquage(), même pour le marketing', async () => {
    const i = new MasquerContactsInterceptor(reflector(true));
    const r = await lastValueFrom(i.intercept(contexte(UserRole.MARKETING), suite(FICHE)));
    expect(r).toEqual(FICHE);
  });

  it('laisse passer ce qui n’est pas du HTTP', async () => {
    const i = new MasquerContactsInterceptor(reflector(false));
    const r = await lastValueFrom(i.intercept(contexte(UserRole.MARKETING, 'ws'), suite(FICHE)));
    expect(r).toEqual(FICHE);
  });

  it('lit la dispense sur la méthode ET sur le contrôleur', () => {
    const vu: unknown[] = [];
    const r = { getAllAndOverride: (cle: string, cibles: unknown[]) => { vu.push(cle, cibles.length); return false; } };
    new MasquerContactsInterceptor(r as unknown as Reflector)
      .intercept(contexte(UserRole.MARKETING), suite(FICHE));
    expect(vu).toEqual([SANS_MASQUAGE, 2]);
  });
});
