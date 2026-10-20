/**
 * Adresse de Google Maps réglable par l'environnement : le banc local la
 * pointe vers une adresse fermée, aucune requête ne part chez Google.
 */
import { GOOGLE_MAPS_API_PRODUCTION, adresseGoogleMaps } from './maps.service';

describe('adresse de Google Maps', () => {
  it('rien de réglé : Google, comme avant', () => {
    expect(adresseGoogleMaps({})).toBe(GOOGLE_MAPS_API_PRODUCTION);
    expect(adresseGoogleMaps({ GOOGLE_MAPS_API_URL: '' })).toBe(GOOGLE_MAPS_API_PRODUCTION);
  });

  it('GOOGLE_MAPS_API_URL réglée : elle seule, sans barre finale', () => {
    expect(adresseGoogleMaps({ GOOGLE_MAPS_API_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
  });
});
