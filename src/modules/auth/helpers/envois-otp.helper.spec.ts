import {
  CLE_ENVOIS_ETRANGER,
  CLE_ENVOIS_ETRANGER_CONNUS,
  CLE_ENVOIS_NOUVEAUX,
  cleDelaiEnvoi,
  cleEnvoisNumero,
  MAX_ENVOIS_ETRANGER_PAR_DEFAUT,
  MAX_ENVOIS_NOUVEAUX_PAR_DEFAUT,
  MAX_ENVOIS_PAR_NUMERO,
  messageDelaiEnvoi,
  plafondDepuisEnv,
  plafondsEnvoi,
  secondesRestantes,
} from './envois-otp.helper';

describe('envois-otp.helper', () => {
  it('les clés ne dépendent pas de la graphie du numéro', () => {
    expect(cleEnvoisNumero('+225 07 20 35 35 35')).toBe(cleEnvoisNumero('2250720353535'));
    expect(cleDelaiEnvoi('+225 07 20 35 35 35')).toBe(cleDelaiEnvoi('2250720353535'));
    expect(cleDelaiEnvoi('+2250720353535')).not.toBe(cleEnvoisNumero('+2250720353535'));
  });

  it("le compteur par numéro ne reprend pas le nom de l'ancien (objet JSON du cache)", () => {
    expect(cleEnvoisNumero('+2250720353535')).not.toBe('otp-envois:numero:2250720353535');
  });

  describe('plafondsEnvoi', () => {
    const cles = (telephone: string, connu: boolean, env = {}) =>
      plafondsEnvoi(telephone, connu, env).map((p) => p.cle);

    it('client ivoirien connu : plafond par numéro seulement', () => {
      expect(cles('+2250707000000', true)).toEqual([cleEnvoisNumero('+2250707000000')]);
    });

    it('numéro ivoirien inconnu : par numéro, puis plafond commun des inconnus', () => {
      const plafonds = plafondsEnvoi('+2250707000000', false, {});
      expect(plafonds.map((p) => [p.cle, p.max, p.commun])).toEqual([
        [cleEnvoisNumero('+2250707000000'), MAX_ENVOIS_PAR_NUMERO, false],
        [CLE_ENVOIS_NOUVEAUX, MAX_ENVOIS_NOUVEAUX_PAR_DEFAUT, true],
      ]);
    });

    it('numéro étranger inconnu : par numéro, étranger, inconnus', () => {
      expect(cles('+33612345678', false)).toEqual([
        cleEnvoisNumero('+33612345678'),
        CLE_ENVOIS_ETRANGER,
        CLE_ENVOIS_NOUVEAUX,
      ]);
    });

    it('numéro étranger connu : un plafond étranger reste (le fraudeur peut valider ses propres numéros), sur son propre compteur', () => {
      expect(cles('+33612345678', true)).toEqual([cleEnvoisNumero('+33612345678'), CLE_ENVOIS_ETRANGER_CONNUS]);
      const plafond = plafondsEnvoi('+33612345678', true, { OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE: '7' })[1];
      expect([plafond.max, plafond.commun]).toEqual([7, true]);
    });

    it('lit les plafonds communs dans l’environnement', () => {
      const plafonds = plafondsEnvoi('+33612345678', false, {
        OTP_ENVOIS_MAX_PAR_HEURE: '150',
        OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE: '5',
      });
      expect(plafonds.find((p) => p.cle === CLE_ENVOIS_ETRANGER)?.max).toBe(5);
      expect(plafonds.find((p) => p.cle === CLE_ENVOIS_NOUVEAUX)?.max).toBe(150);
      expect(plafondsEnvoi('+33612345678', false, {}).find((p) => p.cle === CLE_ENVOIS_ETRANGER)?.max).toBe(
        MAX_ENVOIS_ETRANGER_PAR_DEFAUT,
      );
    });
  });

  it('plafondDepuisEnv : défaut si la variable est absente ou invalide', () => {
    expect(plafondDepuisEnv(undefined, 400)).toBe(400);
    expect(plafondDepuisEnv('abc', 400)).toBe(400);
    expect(plafondDepuisEnv('0', 400)).toBe(400);
    expect(plafondDepuisEnv('-3', 400)).toBe(400);
    expect(plafondDepuisEnv('2.5', 400)).toBe(400);
    expect(plafondDepuisEnv('150', 400)).toBe(150);
  });

  it('secondesRestantes : PTTL arrondi au-dessus, délai entier si Redis ne répond rien d’utile', () => {
    expect(secondesRestantes(17_001, 30_000)).toBe(18);
    expect(secondesRestantes(1, 30_000)).toBe(1);
    expect(secondesRestantes(-2, 30_000)).toBe(30);
    expect(secondesRestantes(null, 60_000)).toBe(60);
  });

  it('messageDelaiEnvoi : singulier et pluriel', () => {
    expect(messageDelaiEnvoi(1)).toBe("Un code vient d'être envoyé. Réessayez dans 1 seconde.");
    expect(messageDelaiEnvoi(29.2)).toBe("Un code vient d'être envoyé. Réessayez dans 30 secondes.");
  });
});
