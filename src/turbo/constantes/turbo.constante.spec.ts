/**
 * Adresse de Turbo réglable par l'environnement. Recette du 20/10 : le banc
 * local a appelé 12 fois la PRODUCTION de Turbo, son adresse étant écrite en
 * dur. Le banc la pointe désormais vers une adresse fermée.
 */
import { TURBO_BASE_PRODUCTION, adresseTurbo } from './turbo.constante';

describe('adresse de Turbo', () => {
  it('rien de réglé : la production, comme avant', () => {
    expect(adresseTurbo({})).toBe(TURBO_BASE_PRODUCTION);
    expect(adresseTurbo({ TURBO_API_URL: '   ' })).toBe(TURBO_BASE_PRODUCTION);
  });

  it('TURBO_API_URL réglée : elle seule, sans barre finale', () => {
    expect(adresseTurbo({ TURBO_API_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
  });

  it('toutes les routes de Turbo suivent l’adresse réglée au chargement', () => {
    const avant = process.env.TURBO_API_URL;
    process.env.TURBO_API_URL = 'http://127.0.0.1:9';
    try {
      jest.isolateModules(() => {
        const { TURBO_API } = require('./turbo.constante');
        const routes = [
          TURBO_API.CREATION_COURSE,
          TURBO_API.FRAIS_LIVRAISON,
          TURBO_API.LISTE_FRAIS,
          TURBO_API.CONFIRMATION_RETRAIT('CRS-1'),
          TURBO_API.ANNULATION_COURSE('CRS-1'),
        ];
        for (const route of routes) expect(route.startsWith('http://127.0.0.1:9/')).toBe(true);
      });
    } finally {
      if (avant === undefined) delete process.env.TURBO_API_URL;
      else process.env.TURBO_API_URL = avant;
    }
  });
});
