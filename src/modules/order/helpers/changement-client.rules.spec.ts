import {
  changeDeClient,
  motifRefusChangementClient,
  REFUS_CLIENT_COUPON,
  REFUS_CLIENT_FIDELITE,
} from './changement-client.rules';

describe('changeDeClient', () => {
  it('vrai seulement pour un autre client', () => {
    expect(changeDeClient('a', 'b')).toBe(true);
    expect(changeDeClient('a', 'a')).toBe(false);
  });

  it('faux quand la modification ne dit rien du client', () => {
    expect(changeDeClient('a', undefined)).toBe(false);
    expect(changeDeClient('a', null)).toBe(false);
    expect(changeDeClient('a', '')).toBe(false);
  });
});

describe('motifRefusChangementClient', () => {
  it('possible sur une commande sans coupon ni fidélité', () => {
    expect(motifRefusChangementClient({})).toBeNull();
    expect(
      motifRefusChangementClient({ codePromo: null, pointsUtilises: 0, mouvementsFidelite: 0, recompenses: 0 }),
    ).toBeNull();
  });

  it('refusé avec un code promo ou un bon', () => {
    expect(motifRefusChangementClient({ codePromo: 'CN-ABC12' })).toBe(REFUS_CLIENT_COUPON);
  });

  it('refusé quand des points ont été dépensés', () => {
    expect(motifRefusChangementClient({ pointsUtilises: 200 })).toBe(REFUS_CLIENT_FIDELITE);
  });

  it('refusé quand des points ou un cadeau sont rattachés à la commande', () => {
    expect(motifRefusChangementClient({ mouvementsFidelite: 1 })).toBe(REFUS_CLIENT_FIDELITE);
    expect(motifRefusChangementClient({ recompenses: 1 })).toBe(REFUS_CLIENT_FIDELITE);
  });

  it('le coupon passe avant la fidélité dans le message', () => {
    expect(motifRefusChangementClient({ codePromo: 'BON', pointsUtilises: 50 })).toBe(REFUS_CLIENT_COUPON);
  });
});
