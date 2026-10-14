import { CHAMPS_CLIENT_MODIFIABLES, champsClientModifiables } from './modification-client.rules';

describe('champsClientModifiables', () => {
  it('laisse passer ce que l’application envoie pour repousser un retrait', () => {
    expect(champsClientModifiables({ date: '2026-10-14T13:00:00.000Z', time: '13:00' })).toEqual({
      date: '2026-10-14T13:00:00.000Z',
      time: '13:00',
    });
  });

  /**
   * LE TEST QUI FERME LE TROU. Chaque champ nommé ici engageait l'argent ou
   * l'acheminement et passait tel quel dans la mise à jour.
   */
  it('ignore tout ce qui engage l’argent ou l’acheminement', () => {
    const corps = {
      date: '2026-10-14T13:00:00.000Z',
      restaurant_id: 'autre-restaurant',
      type: 'DELIVERY',
      payment_method: 'CASH',
      delivery_service: 'TURBO',
      delivery_fee: 0,
      promotion_id: 'promo',
      points: 9999,
      code_promo: 'CNYJASXC',
      status: 'ACCEPTED',
      amount: 1,
      net_amount: 1,
      tax: 0,
      discount: 99999,
      paied: true,
      customer_id: 'autre-client',
      entity_status: 'DELETED',
      items: [{ dish_id: 'x', quantity: 1 }],
    };
    const garde = champsClientModifiables(corps);
    expect(Object.keys(garde)).toEqual(['date']);
  });

  it('ne fabrique pas de champ absent, ni de champ explicitement indéfini', () => {
    expect(champsClientModifiables({})).toEqual({});
    expect(champsClientModifiables({ note: undefined, phone: '0700000000' })).toEqual({ phone: '0700000000' });
  });

  it('accepte un effacement explicite (null) d’un champ autorisé', () => {
    expect(champsClientModifiables({ note: null })).toEqual({ note: null });
  });

  /** Un champ n'entre dans la liste qu'en l'écrivant ici, sous l'avertissement. */
  it('la liste blanche est exactement celle attendue', () => {
    expect([...CHAMPS_CLIENT_MODIFIABLES].sort()).toEqual(
      ['address', 'date', 'email', 'fullname', 'note', 'phone', 'table_type', 'time'].sort(),
    );
  });
});
