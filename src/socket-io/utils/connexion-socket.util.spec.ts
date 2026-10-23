import { Prisma } from '@prisma/client';

import {
  erreurRefus,
  estErreurPassagere,
  lireIdentifiants,
  sujetNonVerifie,
} from './connexion-socket.util';

/**
 * Contrat de connexion à la passerelle `/app` : ce que l'appli lit dans
 * `connect_error`, où le jeton est cherché, et quelles erreurs de base
 * laissent le client réessayer.
 */
describe('connexion-socket.util', () => {
  describe('lireIdentifiants', () => {
    it('requête (applis actuelles) : jeton et type, sans version', () => {
      expect(lireIdentifiants({ query: { token: 'j', type: 'deliverer' } })).toEqual({
        token: 'j',
        type: 'deliverer',
        version: null,
      });
    });

    it('`auth` passe avant la requête (jeton relu à chaque tentative)', () => {
      expect(
        lireIdentifiants({ auth: { token: 'neuf' }, query: { token: 'ancien', type: 'deliverer' } }),
      ).toEqual({ token: 'neuf', type: 'deliverer', version: null });
    });

    it('type inconnu ou absent : null ; valeur non textuelle ignorée', () => {
      expect(lireIdentifiants({ query: { token: 'j', type: 'admin' } }).type).toBeNull();
      expect(lireIdentifiants({ query: { token: ['a', 'b'], type: 'user' } })).toEqual({
        token: '',
        type: 'user',
        version: null,
      });
      expect(lireIdentifiants({})).toEqual({ token: '', type: null, version: null });
    });

    it('version de l\'appli : lue dans `auth` ou la requête, nettoyée pour le journal', () => {
      expect(lireIdentifiants({ auth: { version: '1.4.2 (ota 3e7d946)' } }).version).toBe('1.4.2 ota 3e7d946');
      expect(lireIdentifiants({ query: { version: '1.4.2\nfaux journal' } }).version).toBe('1.4.2faux journal');
      expect(lireIdentifiants({ query: { version: 'x'.repeat(80) } }).version).toHaveLength(40);
      expect(lireIdentifiants({ query: { version: '\n\n' } }).version).toBeNull();
    });
  });

  describe('erreurRefus', () => {
    it('le motif dans le message et dans `data`, avec ce que l\'appli peut tenter', () => {
      const e = erreurRefus('JETON_EXPIRE');
      expect(e.message).toBe('JETON_EXPIRE');
      expect(e.data).toEqual({ motif: 'JETON_EXPIRE', rafraichir_jeton: true });
      expect(erreurRefus('COMPTE_INCONNU').data).toEqual({ motif: 'COMPTE_INCONNU', rafraichir_jeton: false });
    });
  });

  describe('estErreurPassagere', () => {
    const connue = (code: string) =>
      new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

    it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034', 'P2037'])('%s : passagère', (code) => {
      expect(estErreurPassagere(connue(code))).toBe(true);
    });

    it('requête mal formée ou erreur de requête connue : définitive', () => {
      expect(estErreurPassagere(new Prisma.PrismaClientValidationError('x', { clientVersion: 'test' }))).toBe(false);
      expect(estErreurPassagere(connue('P2023'))).toBe(false);
    });

    it('initialisation, réseau, délai : passagères', () => {
      expect(estErreurPassagere(new Prisma.PrismaClientInitializationError('x', 'test'))).toBe(true);
      expect(estErreurPassagere(new Error('ECONNRESET'))).toBe(true);
    });
  });

  describe('sujetNonVerifie', () => {
    it('lit `sub` sans vérifier, rien sur un jeton abîmé', () => {
      const charge = Buffer.from(JSON.stringify({ sub: 'd1' })).toString('base64url');
      expect(sujetNonVerifie(`a.${charge}.b`)).toBe('d1');
      expect(sujetNonVerifie('pas-un-jeton')).toBeNull();
    });
  });
});
