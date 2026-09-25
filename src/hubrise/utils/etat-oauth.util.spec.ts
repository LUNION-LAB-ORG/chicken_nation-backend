/**
 * Le `state` du flux OAuth HubRise.
 *
 * Si l'un de ces tests casse, ne l'adaptez pas au nouveau comportement : c'est
 * ce `state` qui empêche un tiers de relier un restaurant CN à SON compte
 * HubRise (le retour OAuth n'a, par nature, aucune garde).
 */

import { createHmac } from 'crypto';
import {
  DOMAINE_CLE_ETAT,
  DUREE_ETAT_SECONDES,
  cleCacheNonce,
  cleEtatDepuis,
  nouveauNonce,
  signerEtat,
  valeurNonce,
  verifierEtat,
} from './etat-oauth.util';

const CLE = Buffer.from('une-cle-de-test-de-trente-deux-caracteres-au-moins', 'utf8');
const AUTRE_CLE = Buffer.from('une-autre-cle-de-test-de-trente-deux-caracteres', 'utf8');
const RESTAURANT = '3f2b8c1e-5d4a-4b7e-9c10-2a6f8e0d1b23';
const AUTRE_RESTAURANT = '9a1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const ADMIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const AUTRE_ADMIN = 'b1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const MAINTENANT = Date.UTC(2026, 8, 25, 10, 0, 0);
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

const signer = (p: Partial<Parameters<typeof signerEtat>[0]> = {}, cle = CLE) =>
  signerEtat(
    { restaurantId: RESTAURANT, userId: ADMIN, maintenant: MAINTENANT, nonce: NONCE, ...p },
    cle,
  );

/** Remplace la partie `i` du state, signature d'origine conservée. */
const remplacer = (state: string, i: number, valeur: string) => {
  const parties = state.split('.');
  parties[i] = valeur;
  return parties.join('.');
};

describe('state OAuth HubRise : aller-retour', () => {
  it('rend le restaurant, l’utilisateur et le nonce signés', () => {
    const resultat = verifierEtat(signer(), CLE, MAINTENANT + 1000);
    expect(resultat).toEqual({
      ok: true,
      restaurantId: RESTAURANT,
      userId: ADMIN,
      nonce: NONCE,
      expiration: MAINTENANT / 1000 + DUREE_ETAT_SECONDES,
    });
  });

  it('a la forme v1.<restaurant>.<utilisateur>.<exp>.<nonce>.<sig>', () => {
    const parties = signer().split('.');
    expect(parties).toHaveLength(6);
    expect(parties[0]).toBe('v1');
    expect(parties[5]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reste valide jusqu’à la dernière seconde des dix minutes', () => {
    const fin = MAINTENANT + DUREE_ETAT_SECONDES * 1000;
    expect(verifierEtat(signer(), CLE, fin).ok).toBe(true);
  });

  it('accepte des identifiants en majuscules et les rend en minuscules', () => {
    const state = signer({ restaurantId: RESTAURANT.toUpperCase(), userId: ADMIN.toUpperCase() });
    const resultat = verifierEtat(state, CLE, MAINTENANT);
    expect(resultat.ok && resultat.restaurantId).toBe(RESTAURANT);
    expect(resultat.ok && resultat.userId).toBe(ADMIN);
  });

  it('tire un nonce neuf à chaque fois, au bon format', () => {
    const a = nouveauNonce();
    const b = nouveauNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(verifierEtat(signer({ nonce: a }), CLE, MAINTENANT).ok).toBe(true);
  });
});

describe('state OAuth HubRise : expiration', () => {
  it('refuse un lien dépassé d’une seconde, avec le motif lien_expire', () => {
    const apres = MAINTENANT + (DUREE_ETAT_SECONDES + 1) * 1000;
    expect(verifierEtat(signer(), CLE, apres)).toEqual({ ok: false, motif: 'lien_expire' });
  });

  it('refuse une expiration trop lointaine, même bien signée', () => {
    // Signé « dans une heure » : jamais émis par signerEtat, donc invalide.
    const dansUneHeure = signer({ maintenant: MAINTENANT + 3600 * 1000 });
    expect(verifierEtat(dansUneHeure, CLE, MAINTENANT)).toEqual({
      ok: false,
      motif: 'lien_invalide',
    });
  });

  it('un lien falsifié ET expiré est « invalide », pas « expiré »', () => {
    const faux = remplacer(signer(), 1, AUTRE_RESTAURANT);
    const apres = MAINTENANT + (DUREE_ETAT_SECONDES + 1) * 1000;
    expect(verifierEtat(faux, CLE, apres)).toEqual({ ok: false, motif: 'lien_invalide' });
  });
});

describe('state OAuth HubRise : falsification', () => {
  const invalide = { ok: false, motif: 'lien_invalide' };

  it('refuse un autre restaurant sous la même signature', () => {
    expect(verifierEtat(remplacer(signer(), 1, AUTRE_RESTAURANT), CLE, MAINTENANT)).toEqual(
      invalide,
    );
  });

  it('refuse un autre utilisateur sous la même signature', () => {
    expect(verifierEtat(remplacer(signer(), 2, AUTRE_ADMIN), CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse une expiration repoussée sous la même signature', () => {
    const exp = Number(signer().split('.')[3]);
    expect(verifierEtat(remplacer(signer(), 3, String(exp + 60)), CLE, MAINTENANT)).toEqual(
      invalide,
    );
  });

  it('refuse un autre nonce sous la même signature', () => {
    expect(
      verifierEtat(remplacer(signer(), 4, 'BBBBBBBBBBBBBBBBBBBBBB'), CLE, MAINTENANT),
    ).toEqual(invalide);
  });

  it('refuse une signature altérée d’un caractère', () => {
    const state = signer();
    const sig = state.split('.')[5];
    const alteree = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verifierEtat(remplacer(state, 5, alteree), CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse une autre écriture de la même signature (bits ignorés du dernier caractère)', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const state = signer();
    const sig = state.split('.')[5];
    const variante = sig.slice(0, 42) + alphabet[alphabet.indexOf(sig[42]) ^ 1];
    // Même suite d'octets une fois décodée, chaîne différente.
    expect(Buffer.from(variante, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    expect(verifierEtat(remplacer(state, 5, variante), CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse un state signé avec une autre clé', () => {
    expect(verifierEtat(signer({}, AUTRE_CLE), CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse une autre version', () => {
    expect(verifierEtat(remplacer(signer(), 0, 'v2'), CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse un mauvais nombre de parties', () => {
    const state = signer();
    expect(verifierEtat(state.split('.').slice(0, 5).join('.'), CLE, MAINTENANT)).toEqual(
      invalide,
    );
    expect(verifierEtat(`${state}.x`, CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse l’ancien state : l’identifiant du restaurant en clair', () => {
    expect(verifierEtat(RESTAURANT, CLE, MAINTENANT)).toEqual(invalide);
  });

  it('refuse un identifiant qui n’est pas un UUID', () => {
    expect(verifierEtat(remplacer(signer(), 1, 'restaurant-x'), CLE, MAINTENANT)).toEqual(
      invalide,
    );
  });

  it('refuse les valeurs absentes, vides, trop longues ou d’un autre type', () => {
    for (const valeur of [undefined, null, '', 'x'.repeat(1000), ['a', 'b'], { state: 1 }]) {
      expect(verifierEtat(valeur, CLE, MAINTENANT)).toEqual(invalide);
    }
  });
});

describe('state OAuth HubRise : clé', () => {
  it('refuse de signer ou de vérifier avec une clé vide ou trop courte', () => {
    expect(() => signer({}, Buffer.alloc(0))).toThrow();
    expect(() => signer({}, Buffer.from('trop-courte'))).toThrow();
    expect(() => verifierEtat(signer(), Buffer.alloc(0), MAINTENANT)).toThrow();
  });

  it('refuse de signer des entrées mal formées', () => {
    expect(() => signer({ restaurantId: 'pas-un-uuid' })).toThrow();
    expect(() => signer({ userId: '' })).toThrow();
    expect(() => signer({ nonce: 'court' })).toThrow();
  });

  it('prend HUBRISE_STATE_SECRET dès 32 caractères', () => {
    const dediee = 'x'.repeat(32);
    const { cle, source } = cleEtatDepuis(dediee, 'jeton');
    expect(source).toBe('dediee');
    expect(cle.equals(Buffer.from(dediee))).toBe(true);
  });

  it('dérive sinon de TOKEN_SECRET avec une étiquette de domaine, jamais la clé brute', () => {
    const { cle, source, dedieeIgnoree } = cleEtatDepuis(undefined, 'secret-des-jetons');
    expect(source).toBe('derivee');
    expect(dedieeIgnoree).toBe(false);
    expect(cle.equals(Buffer.from('secret-des-jetons'))).toBe(false);
    expect(
      cle.equals(createHmac('sha256', 'secret-des-jetons').update(DOMAINE_CLE_ETAT).digest()),
    ).toBe(true);
  });

  it('ignore une clé dédiée trop courte et le signale', () => {
    const { source, dedieeIgnoree } = cleEtatDepuis('courte', 'secret-des-jetons');
    expect(source).toBe('derivee');
    expect(dedieeIgnoree).toBe(true);
  });

  it('lève une erreur sans aucune clé', () => {
    expect(() => cleEtatDepuis(undefined, undefined)).toThrow();
    expect(() => cleEtatDepuis('', '   ')).toThrow();
  });
});

describe('nonce OAuth HubRise', () => {
  it('lie le nonce au restaurant ET à l’utilisateur', () => {
    expect(valeurNonce(RESTAURANT, ADMIN)).not.toBe(valeurNonce(RESTAURANT, AUTRE_ADMIN));
    expect(valeurNonce(RESTAURANT, ADMIN)).not.toBe(valeurNonce(AUTRE_RESTAURANT, ADMIN));
    expect(valeurNonce(RESTAURANT.toUpperCase(), ADMIN)).toBe(valeurNonce(RESTAURANT, ADMIN));
  });

  it('range le nonce sous un préfixe propre à HubRise', () => {
    expect(cleCacheNonce(NONCE)).toBe(`hubrise:etat:${NONCE}`);
  });
});
