import { customerPhoneVariants, normaliserTelephoneClient } from './customer-phone.util';

describe('normaliserTelephoneClient', () => {
  it('ramène toutes les graphies d’un numéro ivoirien à une seule clé', () => {
    const graphies = [
      '+2250707000000',
      '+225 07 07 00 00 00',
      '+225-07-07-00-00-00',
      '+225 (07) 07.00.00.00',
      '2250707000000',
      '002250707000000',
      '0707000000',
      '07 07 00 00 00',
      '  +2250707000000  ',
    ];
    for (const graphie of graphies) {
      expect(normaliserTelephoneClient(graphie)).toBe('+2250707000000');
    }
  });

  it('garde un numéro fixe ivoirien', () => {
    expect(normaliserTelephoneClient('+2252721234567')).toBe('+2252721234567');
    expect(normaliserTelephoneClient('2721234567')).toBe('+2252721234567');
  });

  it('garde l’indicatif explicite d’un numéro étranger, sans le relire comme ivoirien', () => {
    expect(normaliserTelephoneClient('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(normaliserTelephoneClient('0033612345678')).toBe('+33612345678');
    // Cap-Vert, 7 chiffres après l'indicatif : ne devient pas +225…
    expect(normaliserTelephoneClient('+2389912345')).toBe('+2389912345');
  });

  it('refuse un numéro inexploitable', () => {
    const refuses: unknown[] = [
      '',
      '   ',
      '+',
      'abc',
      '+225 07 07 00 00 0a',
      '+225070700000;--',
      '+225707000000', // +225 suivi de 9 chiffres : premier chiffre oublié
      '+22507070000', // ancienne numérotation à 8 chiffres
      '+2251707000000', // ne commence ni par 0 ni par 2
      '+0707000000', // aucun indicatif ne commence par 0
      '+1234567', // trop court
      '+1234567890123456', // plus de 15 chiffres
      '12345',
      null,
      undefined,
      2250707000000,
      { phone: '+2250707000000' },
    ];
    for (const valeur of refuses) {
      expect(normaliserTelephoneClient(valeur)).toBeNull();
    }
  });

  it('la clé canonique retrouve aussi les lignes héritées sans « + »', () => {
    expect(customerPhoneVariants(normaliserTelephoneClient('+225 07 07 00 00 00')!)).toEqual([
      '+2250707000000',
      '2250707000000',
    ]);
  });
});
