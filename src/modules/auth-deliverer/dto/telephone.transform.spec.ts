import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { LoginDelivererDto } from './login-deliverer.dto';
import { RegisterPhoneDto } from './register-phone.dto';
import { VerifyDelivererOtpDto } from './verify-otp.dto';

/** Même traitement que le ValidationPipe global (transform: true). */
async function transformer<T extends object>(classe: new () => T, corps: object) {
  const dto = plainToInstance(classe, corps);
  const erreurs = await validate(dto);
  return { dto, erreurs };
}

/** Les trois DTO qui reçoivent un téléphone, avec un corps par ailleurs valide. */
const DTOS: Array<[string, new () => { phone: string }, Record<string, unknown>]> = [
  ['RegisterPhoneDto', RegisterPhoneDto, {}],
  ['VerifyDelivererOtpDto', VerifyDelivererOtpDto, { otp: '1234' }],
  ['LoginDelivererDto', LoginDelivererDto, { password: '1234' }],
];

describe.each(DTOS)('%s : téléphone', (_nom, classe, reste) => {
  it('ramène toutes les graphies à la forme enregistrée, `+` puis les chiffres', async () => {
    for (const graphie of [
      '+2250707000000',
      '2250707000000',
      ' +225 07 07 00 00 00 ',
      '+225-07-07-00-00-00',
    ]) {
      const { dto, erreurs } = await transformer(classe, { ...reste, phone: graphie });
      expect(erreurs).toHaveLength(0);
      expect(dto.phone).toBe('+2250707000000');
    }
  });

  it('refuse en 400 un téléphone vide ou qui n’est pas du texte, sans planter', async () => {
    for (const phone of ['', '   ', undefined, null, 2250707000000]) {
      const { erreurs } = await transformer(classe, { ...reste, phone });
      expect(erreurs.map((e) => e.property)).toContain('phone');
    }
  });
});

describe('téléphone : même forme à l’envoi, à la vérification et à la connexion', () => {
  it('donne la même valeur dans les trois DTO', async () => {
    const graphie = '225 07 07 00 00 00';
    const formes = await Promise.all(
      DTOS.map(async ([, classe, reste]) => (await transformer(classe, { ...reste, phone: graphie })).dto.phone),
    );
    expect(new Set(formes)).toEqual(new Set(['+2250707000000']));
  });
});
