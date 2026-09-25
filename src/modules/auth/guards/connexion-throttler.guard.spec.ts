import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from '../controllers/auth.controller';
import { MESSAGE_TROP_DE_CONNEXIONS } from '../helpers/connexion-echecs.helper';
import { ConnexionThrottlerGuard } from './connexion-throttler.guard';

/** Contexte HTTP factice pour POST /auth/login, depuis l'adresse `ip`. */
function contexteConnexion(ip: string): ExecutionContext {
  const req = { ip, headers: {} };
  const res = { header: jest.fn() };
  return {
    getHandler: () => AuthController.prototype.login,
    getClass: () => AuthController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('ConnexionThrottlerGuard sur POST /auth/login', () => {
  let garde: ConnexionThrottlerGuard;
  let module: TestingModule;

  beforeEach(async () => {
    // Même enregistrement que app.module.ts : le défaut (60 par minute) est
    // remplacé par le @Throttle de la route.
    module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
      providers: [ConnexionThrottlerGuard],
    }).compile();
    garde = module.get(ConnexionThrottlerGuard);
    await garde.onModuleInit();
  });

  // Le stockage du limiteur arme un minuteur par requête : on le libère pour
  // que Jest se termine proprement.
  afterEach(async () => {
    await module.close();
  });

  it('laisse passer 10 connexions par minute et par IP, refuse la 11e en français', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(garde.canActivate(contexteConnexion('203.0.113.7'))).resolves.toBe(true);
    }
    const refus = garde.canActivate(contexteConnexion('203.0.113.7'));
    await expect(refus).rejects.toBeInstanceOf(ThrottlerException);
    await expect(garde.canActivate(contexteConnexion('203.0.113.7'))).rejects.toThrow(
      MESSAGE_TROP_DE_CONNEXIONS,
    );
  });

  it('compte chaque adresse séparément', async () => {
    for (let i = 0; i < 10; i++) {
      await garde.canActivate(contexteConnexion('203.0.113.7'));
    }
    await expect(garde.canActivate(contexteConnexion('198.51.100.4'))).resolves.toBe(true);
  });
});
