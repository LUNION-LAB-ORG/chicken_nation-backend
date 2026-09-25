/**
 * Fin du flux OAuth HubRise : droit relu au retour, URL de retour au backoffice.
 */

import { UserRole } from '@prisma/client';
import { BACKOFFICE_URL_DEFAUT, peutConnecterHubrise, urlRetourBackoffice } from './retour-oauth.util';

describe('peutConnecterHubrise (RESTAURANTS CREATE)', () => {
  it('autorise l’administrateur', () => {
    expect(peutConnecterHubrise(UserRole.ADMIN)).toBe(true);
  });

  it('refuse les rôles en lecture seule sur les restaurants', () => {
    expect(peutConnecterHubrise(UserRole.MARKETING)).toBe(false);
    expect(peutConnecterHubrise(UserRole.COMPTABLE)).toBe(false);
  });

  it('refuse le personnel de restaurant et le centre d’appel', () => {
    for (const role of [
      UserRole.CALL_CENTER,
      UserRole.MANAGER,
      UserRole.ASSISTANT_MANAGER,
      UserRole.CAISSIER,
      UserRole.CUISINE,
    ]) {
      expect(peutConnecterHubrise(role)).toBe(false);
    }
  });

  it('refuse un rôle absent ou inconnu', () => {
    expect(peutConnecterHubrise(undefined)).toBe(false);
    expect(peutConnecterHubrise(null)).toBe(false);
    expect(peutConnecterHubrise('')).toBe(false);
    expect(peutConnecterHubrise('SUPER_ADMIN')).toBe(false);
    expect(peutConnecterHubrise('constructor')).toBe(false);
  });
});

describe('urlRetourBackoffice', () => {
  it('renvoie vers le backoffice de production par défaut', () => {
    expect(urlRetourBackoffice(undefined, null)).toBe(
      `${BACKOFFICE_URL_DEFAUT}/gestion?hubrise=connecte`,
    );
    expect(urlRetourBackoffice('   ', null)).toBe(
      `${BACKOFFICE_URL_DEFAUT}/gestion?hubrise=connecte`,
    );
  });

  it('retire la barre finale de BACKOFFICE_URL', () => {
    expect(urlRetourBackoffice('http://localhost:3000/', null)).toBe(
      'http://localhost:3000/gestion?hubrise=connecte',
    );
  });

  it('porte le motif d’échec', () => {
    expect(urlRetourBackoffice('https://bo.exemple', 'deja_relie')).toBe(
      'https://bo.exemple/gestion?hubrise=erreur&motif=deja_relie',
    );
  });

  it('ne porte jamais d’identifiant HubRise', () => {
    expect(urlRetourBackoffice(undefined, null)).not.toMatch(/location/);
  });
});
