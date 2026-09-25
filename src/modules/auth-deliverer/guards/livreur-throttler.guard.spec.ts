import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';

import { AuthDelivererController } from '../controllers/auth-deliverer.controller';
import { MESSAGE_TROP_DE_DEMANDES } from '../helpers/tentatives-livreur.helper';
import { LivreurThrottlerGuard } from './livreur-throttler.guard';

type Methode = keyof AuthDelivererController;

/** Contexte HTTP factice pour une route du contrôleur, depuis l'adresse `ip`. */
function contexte(methode: Methode, ip: string): ExecutionContext {
  const req = { ip, headers: {} };
  const res = { header: jest.fn() };
  return {
    getHandler: () => AuthDelivererController.prototype[methode],
    getClass: () => AuthDelivererController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const gardesDe = (methode: Methode): unknown[] =>
  Reflect.getMetadata(GUARDS_METADATA, AuthDelivererController.prototype[methode]) ?? [];

const limiteDe = (methode: Methode): number | undefined =>
  Reflect.getMetadata('THROTTLER:LIMITdefault', AuthDelivererController.prototype[methode]);

describe('LivreurThrottlerGuard', () => {
  let garde: LivreurThrottlerGuard;
  let module: TestingModule;

  beforeEach(async () => {
    // Même enregistrement que app.module.ts : le défaut (60 par minute) est
    // remplacé par le @Throttle de chaque route.
    module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
      providers: [LivreurThrottlerGuard],
    }).compile();
    garde = module.get(LivreurThrottlerGuard);
    await garde.onModuleInit();
  });

  // Le stockage du limiteur arme un minuteur par requête : on le libère pour
  // que Jest se termine proprement.
  afterEach(async () => {
    await module.close();
  });

  it('laisse passer 10 connexions par minute et par adresse, refuse la 11e en français', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(garde.canActivate(contexte('login', '203.0.113.7'))).resolves.toBe(true);
    }
    const refus = garde.canActivate(contexte('login', '203.0.113.7'));
    await expect(refus).rejects.toBeInstanceOf(ThrottlerException);
    await expect(garde.canActivate(contexte('login', '203.0.113.7'))).rejects.toThrow(
      MESSAGE_TROP_DE_DEMANDES,
    );
  });

  it('limite l’envoi de SMS à 5 par minute et par adresse', async () => {
    for (let i = 0; i < 5; i++) {
      await garde.canActivate(contexte('forgotPassword', '203.0.113.7'));
    }
    await expect(garde.canActivate(contexte('forgotPassword', '203.0.113.7'))).rejects.toThrow(
      MESSAGE_TROP_DE_DEMANDES,
    );
  });

  it('compte chaque route et chaque adresse séparément', async () => {
    for (let i = 0; i < 10; i++) await garde.canActivate(contexte('login', '203.0.113.7'));
    await expect(garde.canActivate(contexte('login', '198.51.100.4'))).resolves.toBe(true);
    await expect(garde.canActivate(contexte('verifyResetOtp', '203.0.113.7'))).resolves.toBe(true);
  });
});

describe('AuthDelivererController : limites posées méthode par méthode', () => {
  it.each<[Methode, number]>([
    ['register', 5],
    ['forgotPassword', 5],
    ['verifyOtp', 10],
    ['verifyResetOtp', 10],
    ['login', 10],
    ['completeRegistration', 10],
    ['resetPassword', 10],
  ])('%s porte la garde et une limite de %i par minute', (methode, limite) => {
    expect(gardesDe(methode)).toContain(LivreurThrottlerGuard);
    expect(limiteDe(methode)).toBe(limite);
  });

  it.each<Methode>(['refreshToken', 'me', 'logout', 'deleteAccount', 'restoreAccount'])(
    '%s reste libre',
    (methode) => {
      expect(gardesDe(methode)).not.toContain(LivreurThrottlerGuard);
      expect(limiteDe(methode)).toBeUndefined();
    },
  );

  it('ne pose aucune garde de débit sur la classe entière', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthDelivererController) ?? []).not.toContain(
      LivreurThrottlerGuard,
    );
  });
});
