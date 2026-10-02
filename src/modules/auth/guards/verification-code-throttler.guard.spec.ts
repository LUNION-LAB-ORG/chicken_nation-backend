import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from '../controllers/auth.controller';
import { MESSAGE_TROP_D_ESSAIS_IP } from '../helpers/envois-otp.helper';
import { VerificationCodeThrottlerGuard } from './verification-code-throttler.guard';

/** Contexte HTTP factice pour POST /auth/customer/verify-otp, depuis l'adresse `ip`. */
function contexteVerification(ip: string): ExecutionContext {
  const req = { ip, headers: {} };
  const res = { header: jest.fn() };
  return {
    getHandler: () => AuthController.prototype.verifyOtpCustomer,
    getClass: () => AuthController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('VerificationCodeThrottlerGuard sur POST /auth/customer/verify-otp', () => {
  let garde: VerificationCodeThrottlerGuard;
  let module: TestingModule;

  beforeEach(async () => {
    // Même enregistrement que app.module.ts : le défaut (60 par minute) est
    // remplacé par le @Throttle de la route.
    module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
      providers: [VerificationCodeThrottlerGuard],
    }).compile();
    garde = module.get(VerificationCodeThrottlerGuard);
    await garde.onModuleInit();
  });

  afterEach(async () => {
    await module.close();
  });

  it('laisse passer 30 essais par minute et par IP, refuse le 31e en français', async () => {
    for (let i = 0; i < 30; i++) {
      await expect(garde.canActivate(contexteVerification('203.0.113.7'))).resolves.toBe(true);
    }
    const refus = garde.canActivate(contexteVerification('203.0.113.7'));
    await expect(refus).rejects.toBeInstanceOf(ThrottlerException);
    await expect(garde.canActivate(contexteVerification('203.0.113.7'))).rejects.toThrow(
      MESSAGE_TROP_D_ESSAIS_IP,
    );
  });

  it('compte chaque adresse séparément', async () => {
    for (let i = 0; i < 30; i++) {
      await garde.canActivate(contexteVerification('203.0.113.7'));
    }
    await expect(garde.canActivate(contexteVerification('198.51.100.4'))).resolves.toBe(true);
  });
});
