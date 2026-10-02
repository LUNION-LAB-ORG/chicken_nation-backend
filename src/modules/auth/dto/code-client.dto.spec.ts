import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MESSAGE_CODE_INVALIDE, MESSAGE_NUMERO_INVALIDE } from '../helpers/envois-otp.helper';
import { LoginCustomerDto } from './login-customer.dto';
import { VerifyOtpDto } from './verify-otp.dto';

/** Messages de la réponse 400, comme ValidationPipe les met à plat. */
async function messages<T extends object>(classe: new () => T, corps: object): Promise<string[]> {
  const erreurs = await validate(plainToInstance(classe, corps));
  return erreurs.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('DTO de la connexion par code (client)', () => {
  it('accepte les envois de l’application et du site', async () => {
    expect(await messages(LoginCustomerDto, { phone: '+2250707000000' })).toEqual([]);
    expect(await messages(LoginCustomerDto, { phone: ' +225 07 07 00 00 00 ' })).toEqual([]);
    expect(await messages(VerifyOtpDto, { phone: '+2250707000000', otp: '0042' })).toEqual([]);
    expect(await messages(VerifyOtpDto, { phone: '+33612345678', otp: ' 1234 ' })).toEqual([]);
  });

  it('un seul message par champ refusé, même absent', async () => {
    expect(await messages(LoginCustomerDto, {})).toEqual([MESSAGE_NUMERO_INVALIDE]);
    expect(await messages(VerifyOtpDto, {})).toEqual([MESSAGE_NUMERO_INVALIDE, MESSAGE_CODE_INVALIDE]);
  });

  it.each([['abc'], ['+225 07 07 00 00 0a'], ['1234567'], ['+' + '2'.repeat(21)], [2250707000000]])(
    'refuse le numéro %p',
    async (phone) => {
      expect(await messages(LoginCustomerDto, { phone })).toEqual([MESSAGE_NUMERO_INVALIDE]);
      expect(await messages(VerifyOtpDto, { phone, otp: '1234' })).toEqual([MESSAGE_NUMERO_INVALIDE]);
    },
  );

  it.each([['123'], ['12345'], ['12a4'], [''], [1234], [null]])(
    'refuse le code %p (exactement 4 chiffres, en texte)',
    async (otp) => {
      expect(await messages(VerifyOtpDto, { phone: '+2250707000000', otp })).toEqual([
        MESSAGE_CODE_INVALIDE,
      ]);
    },
  );
});
