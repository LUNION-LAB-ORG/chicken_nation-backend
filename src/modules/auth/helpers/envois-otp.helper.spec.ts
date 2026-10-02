import {
  apresEnvoi,
  cleEnvoisNumero,
  FENETRE_ENVOIS_MS,
  lireCompteur,
  MAX_ENVOIS_GLOBAL_PAR_DEFAUT,
  plafondAtteint,
  plafondGlobal,
} from './envois-otp.helper';

describe('envois-otp.helper', () => {
  const t0 = 1_000_000_000;

  it('la clé ne dépend pas de la graphie du numéro', () => {
    expect(cleEnvoisNumero('+225 07 20 35 35 35')).toBe(cleEnvoisNumero('2250720353535'));
  });

  it('compte les envois dans la fenêtre puis bloque au plafond', () => {
    let compteur = lireCompteur(undefined, t0);
    for (let i = 0; i < 5; i++) {
      expect(plafondAtteint(compteur, 5)).toBe(false);
      compteur = apresEnvoi(compteur, t0 + i * 1000).compteur;
    }
    expect(plafondAtteint(compteur, 5)).toBe(true);
  });

  it('la fenêtre écoulée remet le compteur à zéro', () => {
    const { compteur } = apresEnvoi(null, t0);
    expect(lireCompteur(compteur, t0 + FENETRE_ENVOIS_MS - 1)).not.toBeNull();
    expect(lireCompteur(compteur, t0 + FENETRE_ENVOIS_MS)).toBeNull();
  });

  it('la durée de vie du cache suit la fin de la fenêtre', () => {
    const premier = apresEnvoi(null, t0);
    expect(premier.ttlMs).toBe(FENETRE_ENVOIS_MS);
    const second = apresEnvoi(premier.compteur, t0 + 10 * 60 * 1000);
    expect(second.ttlMs).toBe(FENETRE_ENVOIS_MS - 10 * 60 * 1000);
    expect(second.compteur.depuis).toBe(t0);
  });

  it('une valeur de cache illisible vaut « aucun envoi »', () => {
    expect(lireCompteur('n importe quoi', t0)).toBeNull();
    expect(lireCompteur({ envois: -1, depuis: t0 }, t0)).toBeNull();
  });

  it('plafond global : défaut si la variable est absente ou invalide', () => {
    expect(plafondGlobal(undefined)).toBe(MAX_ENVOIS_GLOBAL_PAR_DEFAUT);
    expect(plafondGlobal('abc')).toBe(MAX_ENVOIS_GLOBAL_PAR_DEFAUT);
    expect(plafondGlobal('0')).toBe(MAX_ENVOIS_GLOBAL_PAR_DEFAUT);
    expect(plafondGlobal('150')).toBe(150);
  });
});
