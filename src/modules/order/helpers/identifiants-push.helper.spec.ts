/**
 * Aucune commande ne sort, par une réponse ou un socket, avec de quoi envoyer
 * une notification au téléphone du client : le serveur pousse sans jeton
 * d'accès Expo, un jeton divulgué suffit donc à écrire au client au nom de
 * Chicken Nation.
 */

import { CLES_IDENTIFIANTS_PUSH, sansIdentifiantsPush } from './identifiants-push.helper';

const commande = () => ({
  id: 'o1',
  reference: 'CMD-1',
  amount: 8000,
  recovery_code: '4821',
  created_at: new Date('2026-09-25T10:00:00Z'),
  customer: {
    id: 'c1',
    first_name: 'Awa',
    last_name: 'Koné',
    phone: '+2250700000000',
    email: 'awa@example.com',
    image: null,
    notification_settings: {
      customer_id: 'c1',
      push: true,
      expo_push_token: 'ExponentPushToken[abc]',
      expo_push_token_revoked: 'ExponentPushToken[old]',
      expo_push_token_revoked_at: new Date(),
      onesignal_id: 'os-1',
      onesignal_subscription_id: 'os-sub-1',
    },
  },
  order_items: [{ id: 'i1', options: [{ label: 'Sauce', price_delta: 0 }], dish: { id: 'd1', name: 'Burger' } }],
  delivery: {
    course: {
      deliverer: { id: 'l1', first_name: 'Yao', expo_push_token: 'ExponentPushToken[livreur]' },
    },
  },
  user: { id: 'u1', fullname: 'Caisse', expo_push_token: 'ExponentPushToken[caisse]' },
});

/** Toutes les clés présentes, à toute profondeur. */
function toutesLesCles(valeur: unknown, cles = new Set<string>()): Set<string> {
  if (Array.isArray(valeur)) {
    valeur.forEach((v) => toutesLesCles(v, cles));
  } else if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) {
    for (const [cle, contenu] of Object.entries(valeur)) {
      cles.add(cle);
      toutesLesCles(contenu, cles);
    }
  }
  return cles;
}

describe('sansIdentifiantsPush', () => {
  it('retire les réglages de notification du client et tout jeton, à toute profondeur', () => {
    const cles = toutesLesCles(sansIdentifiantsPush(commande()));
    for (const interdite of CLES_IDENTIFIANTS_PUSH) {
      expect(cles.has(interdite)).toBe(false);
    }
  });

  it('garde ce que lisent la caisse, le back office et l’application client', () => {
    const propre = sansIdentifiantsPush(commande());
    expect(propre.customer).toEqual({
      id: 'c1',
      first_name: 'Awa',
      last_name: 'Koné',
      phone: '+2250700000000',
      email: 'awa@example.com',
      image: null,
    });
    expect(propre.reference).toBe('CMD-1');
    expect(propre.amount).toBe(8000);
    expect(propre.order_items[0].options).toEqual([{ label: 'Sauce', price_delta: 0 }]);
    expect(propre.delivery.course.deliverer).toEqual({ id: 'l1', first_name: 'Yao' });
  });

  it('ne touche pas au code de récupération : c’est l’affaire de la diffusion', () => {
    expect(sansIdentifiantsPush(commande()).recovery_code).toBe('4821');
  });

  it('rend les dates telles quelles', () => {
    const propre = sansIdentifiantsPush(commande());
    expect(propre.created_at).toBeInstanceOf(Date);
    expect(propre.created_at.toISOString()).toBe('2026-09-25T10:00:00.000Z');
  });

  it('ne modifie pas l’original : l’appelant y lit encore le jeton pour son envoi', () => {
    const original = commande();
    sansIdentifiantsPush(original);
    expect(original.customer.notification_settings.expo_push_token).toBe('ExponentPushToken[abc]');
  });

  it('laisse passer null et les valeurs simples', () => {
    expect(sansIdentifiantsPush(null)).toBeNull();
    expect(sansIdentifiantsPush(undefined)).toBeUndefined();
    expect(sansIdentifiantsPush('texte')).toBe('texte');
  });
});
