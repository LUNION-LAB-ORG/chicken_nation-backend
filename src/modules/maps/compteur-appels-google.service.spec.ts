/**
 * Compteur d'appels à Google par fonction et par jour, et plafond quotidien
 * `maps.plafond_appels_jour` au-delà duquel les fonctions qui ont un repli
 * passent sans Google.
 */
import {
  cleCompteur,
  CompteurAppelsGoogleService,
  jourCompteur,
  lirePlafondAppels,
  PLAFOND_APPELS_JOUR_DEFAUT,
} from './compteur-appels-google.service';
import type { ClientRedisCompteur } from './redis-compteur-google.provider';

/** Redis en mémoire : MULTI (INCR, DECR, EXPIRE), MGET, QUIT, et une panne à la demande. */
function redisSimule() {
  const cles = new Map<string, number>();
  const expirations = new Map<string, number>();
  let enPanne = false;

  const client = {
    multi: jest.fn(() => {
      const file: (() => unknown)[] = [];
      const transaction = {
        incr: (cle: string) => {
          file.push(() => {
            cles.set(cle, (cles.get(cle) ?? 0) + 1);
            return cles.get(cle);
          });
          return transaction;
        },
        decr: (cle: string) => {
          file.push(() => {
            cles.set(cle, (cles.get(cle) ?? 0) - 1);
            return cles.get(cle);
          });
          return transaction;
        },
        expire: (cle: string, secondes: number) => {
          file.push(() => {
            expirations.set(cle, secondes);
            return 1;
          });
          return transaction;
        },
        exec: async () => {
          await Promise.resolve();
          if (enPanne) throw new Error('Connection is closed.');
          return file.map((executer) => [null, executer()]);
        },
      };
      return transaction;
    }),
    mget: jest.fn(async (...demandees: string[]) => {
      if (enPanne) throw new Error('Connection is closed.');
      return demandees.map((c) => (cles.has(c) ? String(cles.get(c)) : null));
    }),
    quit: jest.fn(async () => 'OK'),
  };

  return {
    client: client as unknown as ClientRedisCompteur,
    valeur: (cle: string) => cles.get(cle) ?? 0,
    expiration: (cle: string) => expirations.get(cle),
    panne: (oui: boolean) => {
      enPanne = oui;
    },
  };
}

function reglages(plafond: string | null | (() => never)) {
  return {
    get: jest.fn(async () => (typeof plafond === 'function' ? plafond() : plafond)),
  };
}

const MIDI = new Date('2026-10-23T12:00:00.000Z');
const JOUR = '2026-10-23';

function monter(plafond: string | null | (() => never) = '3') {
  const redis = redisSimule();
  const settings = reglages(plafond);
  const compteur = new CompteurAppelsGoogleService(redis.client, settings as never);
  return { compteur, redis, settings };
}

describe('lirePlafondAppels', () => {
  it('absent : 2 000 ; 0 accepté ; négatif ou illisible refusé et signalé', () => {
    expect(lirePlafondAppels(null)).toEqual({ plafond: PLAFOND_APPELS_JOUR_DEFAUT, refuse: false });
    expect(lirePlafondAppels('')).toEqual({ plafond: 2000, refuse: false });
    expect(lirePlafondAppels('0')).toEqual({ plafond: 0, refuse: false });
    expect(lirePlafondAppels('1500')).toEqual({ plafond: 1500, refuse: false });
    expect(lirePlafondAppels('-1')).toEqual({ plafond: 2000, refuse: true });
    expect(lirePlafondAppels('beaucoup')).toEqual({ plafond: 2000, refuse: true });
  });
});

describe('jourCompteur', () => {
  it('jour UTC, qui est celui d’Abidjan', () => {
    expect(jourCompteur(new Date('2026-10-23T23:59:59.000Z'))).toBe('2026-10-23');
    expect(jourCompteur(new Date('2026-10-24T00:00:00.000Z'))).toBe('2026-10-24');
  });
});

describe('CompteurAppelsGoogleService', () => {
  it('compte chaque appel plafonné par fonction et au total, avec une durée de vie', async () => {
    const { compteur, redis } = monter('10');
    await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    await expect(compteur.reserver('detour', MIDI)).resolves.toBe(true);
    await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    expect(redis.valeur(cleCompteur(JOUR, 'itineraire'))).toBe(2);
    expect(redis.valeur(cleCompteur(JOUR, 'detour'))).toBe(1);
    expect(redis.valeur(cleCompteur(JOUR, 'plafonnes'))).toBe(3);
    expect(redis.expiration(cleCompteur(JOUR, 'plafonnes'))).toBe(8 * 24 * 60 * 60);
  });

  it('au-delà du plafond : refusé (repli), rien n’est pris, le refus est compté', async () => {
    const { compteur, redis } = monter('3');
    for (let i = 0; i < 3; i++) await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    await expect(compteur.reserver('detour', MIDI)).resolves.toBe(false);
    await expect(compteur.reserver('temps_trajet', MIDI)).resolves.toBe(false);
    expect(redis.valeur(cleCompteur(JOUR, 'plafonnes'))).toBe(3);
    expect(redis.valeur(cleCompteur(JOUR, 'detour'))).toBe(0);
    expect(redis.valeur(cleCompteur(JOUR, 'refuses'))).toBe(2);
  });

  it('le lendemain, le compteur repart de zéro', async () => {
    const { compteur } = monter('1');
    await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(false);
    await expect(compteur.reserver('itineraire', new Date('2026-10-24T00:00:01.000Z'))).resolves.toBe(true);
  });

  it('les fonctions sans repli (trajet affiché, saisie d’adresse) sont comptées mais jamais coupées', async () => {
    const { compteur, redis } = monter('0');
    await expect(compteur.reserver('trajet_trafic', MIDI)).resolves.toBe(true);
    await expect(compteur.reserver('saisie_adresse', MIDI)).resolves.toBe(true);
    compteur.compter('details_lieu', MIDI);
    await new Promise((fin) => setImmediate(fin));
    expect(redis.valeur(cleCompteur(JOUR, 'trajet_trafic'))).toBe(1);
    expect(redis.valeur(cleCompteur(JOUR, 'saisie_adresse'))).toBe(1);
    expect(redis.valeur(cleCompteur(JOUR, 'details_lieu'))).toBe(1);
    expect(redis.valeur(cleCompteur(JOUR, 'plafonnes'))).toBe(0);
  });

  it('plafond à 0 : aucun appel plafonné', async () => {
    const { compteur, redis } = monter('0');
    await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(false);
    await new Promise((fin) => setImmediate(fin));
    expect(redis.valeur(cleCompteur(JOUR, 'plafonnes'))).toBe(0);
    expect(redis.valeur(cleCompteur(JOUR, 'refuses'))).toBe(1);
  });

  it('réglage refusé ou base muette : plafond par défaut (2 000)', async () => {
    const refuse = monter('-4');
    await expect(refuse.compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    const muette = monter(() => {
      throw new Error('P1001');
    });
    await expect(muette.compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    await expect(muette.compteur.compteursDuJour(MIDI)).resolves.toMatchObject({ plafond: 2000 });
  });

  it('Redis en panne : Google reste utilisé (pas de coupure faute de compteur), jamais d’exception', async () => {
    const { compteur, redis } = monter('3');
    redis.panne(true);
    await expect(compteur.reserver('itineraire', MIDI)).resolves.toBe(true);
    expect(() => compteur.compter('vignette', MIDI)).not.toThrow();
    await expect(compteur.compteursDuJour(MIDI)).resolves.toMatchObject({ plafonnes: 0 });
  });

  it('compteursDuJour : par fonction, total, refus et plafond', async () => {
    const { compteur } = monter('2');
    await compteur.reserver('itineraire', MIDI);
    await compteur.reserver('detour', MIDI);
    await compteur.reserver('detour', MIDI);
    await compteur.reserver('trajet_trafic', MIDI);
    await new Promise((fin) => setImmediate(fin));
    const etat = await compteur.compteursDuJour(MIDI);
    expect(etat).toMatchObject({ jour: JOUR, plafonnes: 2, refuses: 1, plafond: 2 });
    expect(etat.parFonction).toMatchObject({ itineraire: 1, detour: 1, trajet_trafic: 1, vignette: 0 });
  });
});
