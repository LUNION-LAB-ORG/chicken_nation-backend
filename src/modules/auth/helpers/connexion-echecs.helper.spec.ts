import {
  DUREE_BLOCAGE_CONNEXION_MS,
  EtatEchecsConnexion,
  FENETRE_ECHECS_CONNEXION_MS,
  MAX_ECHECS_CONNEXION,
  MESSAGE_IDENTIFIANTS_INCORRECTS,
  MESSAGE_TROP_DE_CONNEXIONS,
  cleEchecsConnexion,
  etatApresEchec,
  lireEtatEchecs,
  messageBlocageConnexion,
  minutesRestantesBlocage,
  origineConnexion,
  pourJournal,
} from './connexion-echecs.helper';

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);
const MINUTE = 60_000;

/** Enchaîne `n` échecs à une seconde d'intervalle à partir de `debut`. */
function echouer(n: number, debut = T0, etat: EtatEchecsConnexion | null = null) {
  let courant = etat;
  let dernier = etatApresEchec(courant, debut);
  for (let i = 0; i < n; i++) {
    dernier = etatApresEchec(courant, debut + i * 1000);
    courant = dernier.etat;
  }
  return dernier;
}

describe('cleEchecsConnexion', () => {
  it('ignore la casse et les espaces autour de l’email', () => {
    expect(cleEchecsConnexion('  Caisse@Chicken-Nation.com ')).toBe(
      'connexion-echecs:caisse@chicken-nation.com',
    );
    expect(cleEchecsConnexion('caisse@chicken-nation.com')).toBe(
      cleEchecsConnexion('CAISSE@CHICKEN-NATION.COM'),
    );
  });
});

describe('lireEtatEchecs', () => {
  it('relit un état bien formé', () => {
    expect(lireEtatEchecs({ echecs: 2, depuis: T0, bloqueJusqua: null })).toEqual({
      echecs: 2,
      depuis: T0,
      bloqueJusqua: null,
    });
  });

  it('traite une valeur absente ou abîmée comme « aucun échec »', () => {
    expect(lireEtatEchecs(undefined)).toBeNull();
    expect(lireEtatEchecs(null)).toBeNull();
    expect(lireEtatEchecs('5')).toBeNull();
    expect(lireEtatEchecs({ echecs: '5', depuis: T0 })).toBeNull();
    expect(lireEtatEchecs({ echecs: 5 })).toBeNull();
    expect(lireEtatEchecs({ echecs: -1, depuis: T0 })).toBeNull();
  });

  it('ignore un verrou illisible', () => {
    expect(lireEtatEchecs({ echecs: 1, depuis: T0, bloqueJusqua: 'demain' })?.bloqueJusqua).toBeNull();
  });
});

describe('etatApresEchec', () => {
  it('ouvre une fenêtre au premier échec, sans verrou', () => {
    const r = etatApresEchec(null, T0);
    expect(r.etat).toEqual({ echecs: 1, depuis: T0, bloqueJusqua: null });
    expect(r.minutesBlocage).toBe(0);
    expect(r.ttlMs).toBe(FENETRE_ECHECS_CONNEXION_MS);
  });

  it(`ne verrouille pas avant ${MAX_ECHECS_CONNEXION} échecs`, () => {
    const r = echouer(MAX_ECHECS_CONNEXION - 1);
    expect(r.etat.echecs).toBe(MAX_ECHECS_CONNEXION - 1);
    expect(r.etat.bloqueJusqua).toBeNull();
    expect(r.minutesBlocage).toBe(0);
  });

  it(`verrouille au ${MAX_ECHECS_CONNEXION}e échec pour 15 minutes`, () => {
    const r = echouer(MAX_ECHECS_CONNEXION);
    const instant = T0 + (MAX_ECHECS_CONNEXION - 1) * 1000;
    expect(r.etat.echecs).toBe(MAX_ECHECS_CONNEXION);
    expect(r.etat.bloqueJusqua).toBe(instant + DUREE_BLOCAGE_CONNEXION_MS);
    expect(r.minutesBlocage).toBe(15);
    expect(r.ttlMs).toBe(DUREE_BLOCAGE_CONNEXION_MS);
  });

  it('repart de 1 quand la fenêtre est écoulée', () => {
    const avant = echouer(3).etat;
    const r = etatApresEchec(avant, T0 + FENETRE_ECHECS_CONNEXION_MS + MINUTE);
    expect(r.etat.echecs).toBe(1);
    expect(r.etat.depuis).toBe(T0 + FENETRE_ECHECS_CONNEXION_MS + MINUTE);
    expect(r.minutesBlocage).toBe(0);
  });

  it('repart de 1 une fois le verrou levé', () => {
    const verrouille = echouer(MAX_ECHECS_CONNEXION).etat;
    const apres = (verrouille.bloqueJusqua as number) + 1;
    const r = etatApresEchec(verrouille, apres);
    expect(r.etat).toEqual({ echecs: 1, depuis: apres, bloqueJusqua: null });
  });

  it('donne à la clé la durée restante de la fenêtre, jamais moins d’une seconde', () => {
    const premier = etatApresEchec(null, T0).etat;
    const r = etatApresEchec(premier, T0 + 10 * MINUTE);
    expect(r.ttlMs).toBe(FENETRE_ECHECS_CONNEXION_MS - 10 * MINUTE);
    const limite = etatApresEchec(premier, T0 + FENETRE_ECHECS_CONNEXION_MS);
    expect(limite.ttlMs).toBeGreaterThanOrEqual(1000);
  });
});

describe('minutesRestantesBlocage', () => {
  it('vaut 0 sans état ni verrou', () => {
    expect(minutesRestantesBlocage(null, T0)).toBe(0);
    expect(minutesRestantesBlocage({ echecs: 3, depuis: T0, bloqueJusqua: null }, T0)).toBe(0);
  });

  it('arrondit les minutes restantes au-dessus', () => {
    const etat = { echecs: 5, depuis: T0, bloqueJusqua: T0 + 15 * MINUTE };
    expect(minutesRestantesBlocage(etat, T0)).toBe(15);
    expect(minutesRestantesBlocage(etat, T0 + 14 * MINUTE + 1)).toBe(1);
  });

  it('vaut 0 une fois le verrou expiré', () => {
    const etat = { echecs: 5, depuis: T0, bloqueJusqua: T0 + 15 * MINUTE };
    expect(minutesRestantesBlocage(etat, T0 + 15 * MINUTE)).toBe(0);
    expect(minutesRestantesBlocage(etat, T0 + 20 * MINUTE)).toBe(0);
  });
});

describe('messages', () => {
  it('accorde « minute » au singulier et au pluriel', () => {
    expect(messageBlocageConnexion(1)).toBe(
      'Trop de tentatives de connexion. Réessayez dans 1 minute.',
    );
    expect(messageBlocageConnexion(15)).toBe(
      'Trop de tentatives de connexion. Réessayez dans 15 minutes.',
    );
    expect(messageBlocageConnexion(0)).toContain('1 minute.');
  });

  it('sont en français, sans tiret long ni « N/A »', () => {
    for (const m of [
      MESSAGE_IDENTIFIANTS_INCORRECTS,
      MESSAGE_TROP_DE_CONNEXIONS,
      messageBlocageConnexion(3),
    ]) {
      expect(m).not.toMatch(/[–—]/);
      expect(m).not.toContain('N/A');
    }
  });
});

describe('pourJournal', () => {
  it('neutralise les sauts de ligne et caractères de contrôle d’une saisie', () => {
    expect(pourJournal('pirate@x.com\n[Nest] LOG Connexion réussie')).toBe(
      'pirate@x.com?[Nest] LOG Connexion réussie',
    );
    expect(pourJournal('a\r\tb\u0000c\u2028d')).toBe('a??b?c?d');
  });

  it('garde une saisie ordinaire telle quelle et borne la longueur', () => {
    expect(pourJournal('caisse@chicken-nation.com')).toBe('caisse@chicken-nation.com');
    expect(pourJournal('x'.repeat(300))).toBe(`${'x'.repeat(200)}...`);
    expect(pourJournal(undefined)).toBe('');
  });
});

describe('origineConnexion', () => {
  it('journalise toute la chaîne X-Forwarded-For quand l’appelant en envoie une', () => {
    // L'appelant a écrit 1.2.3.4 ; le proxy a ajouté l'adresse qu'il a vue.
    expect(origineConnexion({ ip: '1.2.3.4', ips: ['1.2.3.4', '203.0.113.9'] })).toBe(
      '1.2.3.4, 203.0.113.9',
    );
  });

  it('se contente de req.ip sinon', () => {
    expect(origineConnexion({ ip: '203.0.113.9', ips: ['203.0.113.9'] })).toBe('203.0.113.9');
    expect(origineConnexion({ ip: '127.0.0.1', ips: [] })).toBe('127.0.0.1');
    expect(origineConnexion({})).toBe('adresse inconnue');
  });
});
