import {
  DELAI_RENVOI_CODE_MS,
  POLITIQUE_CODE,
  POLITIQUE_CONNEXION,
  POLITIQUE_CONNEXION_JOUR,
  cleConnexion,
  cleConnexionJour,
  cleVerificationCode,
  debutFenetreValide,
  depassePlafond,
  doitVerrouiller,
  estPerime,
  finBlocage,
  messageDelaiRenvoi,
  messageTropDeTentatives,
  normaliserTelephone,
  resteBlocageMs,
} from './tentatives-livreur.helper';

const MINUTE = 60 * 1000;
const T0 = new Date('2026-09-25T10:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('tentatives-livreur.helper', () => {
  describe('clés', () => {
    it('ramène toutes les graphies d’un numéro à la même clé', () => {
      const graphies = ['+2250707000000', '2250707000000', '+225 07 07 00 00 00', ' +225-07-07-00-00-00 '];
      const cles = new Set(graphies.map(normaliserTelephone));
      expect([...cles]).toEqual(['+2250707000000']);
    });

    it('garde le téléphone nu pour les codes, pour partager le compteur avec les clients', () => {
      expect(cleVerificationCode('225 0707000000')).toBe('+2250707000000');
    });

    it('préfixe les clés de connexion, qui ne se mélangent ni entre elles ni avec les codes', () => {
      const cles = [
        cleVerificationCode('+2250707000000'),
        cleConnexion('+2250707000000'),
        cleConnexionJour('+2250707000000'),
      ];
      expect(new Set(cles).size).toBe(3);
      expect(cleConnexion('2250707000000')).toBe('livreur-connexion:+2250707000000');
      expect(cleConnexionJour('+225 0707000000')).toBe('livreur-connexion-jour:+2250707000000');
    });
  });

  describe('politiques', () => {
    it('5 essais par quart d’heure pour les codes et la connexion, 15 par jour pour la connexion', () => {
      expect(POLITIQUE_CODE).toEqual({ max: 5, fenetreMs: 15 * MINUTE, blocageMs: 15 * MINUTE });
      expect(POLITIQUE_CONNEXION).toEqual({ max: 5, fenetreMs: 15 * MINUTE, blocageMs: 15 * MINUTE });
      expect(POLITIQUE_CONNEXION_JOUR).toEqual({
        max: 15,
        fenetreMs: 24 * 60 * MINUTE,
        blocageMs: 24 * 60 * MINUTE,
      });
      expect(DELAI_RENVOI_CODE_MS).toBe(60 * 1000);
    });
  });

  describe('plafond', () => {
    it('examine les 5 premières tentatives et refuse la 6e', () => {
      expect([1, 2, 3, 4, 5].some((rang) => depassePlafond(rang, POLITIQUE_CODE))).toBe(false);
      expect(depassePlafond(6, POLITIQUE_CODE)).toBe(true);
    });

    it('pose le verrou au 5e échec', () => {
      expect(doitVerrouiller(4, POLITIQUE_CONNEXION)).toBe(false);
      expect(doitVerrouiller(5, POLITIQUE_CONNEXION)).toBe(true);
      expect(doitVerrouiller(14, POLITIQUE_CONNEXION_JOUR)).toBe(false);
      expect(doitVerrouiller(15, POLITIQUE_CONNEXION_JOUR)).toBe(true);
    });

    it('fait durer le verrou selon la politique', () => {
      expect(finBlocage(T0, POLITIQUE_CONNEXION)).toEqual(plus(15 * MINUTE));
      expect(finBlocage(T0, POLITIQUE_CONNEXION_JOUR)).toEqual(plus(24 * 60 * MINUTE));
    });
  });

  describe('resteBlocageMs', () => {
    it('vaut 0 sans état, sans verrou ou avec un verrou échu', () => {
      expect(resteBlocageMs(null, T0)).toBe(0);
      expect(resteBlocageMs({ failed_count: 3, window_start: T0, locked_until: null }, T0)).toBe(0);
      expect(
        resteBlocageMs({ failed_count: 5, window_start: T0, locked_until: plus(-1) }, T0),
      ).toBe(0);
    });

    it('donne le temps restant d’un verrou actif', () => {
      const etat = { failed_count: 5, window_start: T0, locked_until: plus(15 * MINUTE) };
      expect(resteBlocageMs(etat, plus(5 * MINUTE))).toBe(10 * MINUTE);
    });
  });

  describe('estPerime', () => {
    it('garde une fenêtre en cours', () => {
      const etat = { failed_count: 2, window_start: T0, locked_until: null };
      expect(estPerime(etat, plus(15 * MINUTE), POLITIQUE_CODE)).toBe(false);
    });

    it('repart de zéro quand la fenêtre est écoulée', () => {
      const etat = { failed_count: 4, window_start: T0, locked_until: null };
      expect(estPerime(etat, plus(15 * MINUTE + 1), POLITIQUE_CODE)).toBe(true);
      expect(debutFenetreValide(plus(15 * MINUTE + 1), POLITIQUE_CODE)).toEqual(plus(1));
    });

    it('n’efface jamais un verrou actif, même quand sa fenêtre est finie', () => {
      const etat = { failed_count: 5, window_start: T0, locked_until: plus(29 * MINUTE) };
      expect(estPerime(etat, plus(20 * MINUTE), POLITIQUE_CODE)).toBe(false);
    });

    it('repart de zéro quand le verrou est échu', () => {
      const etat = { failed_count: 5, window_start: T0, locked_until: plus(15 * MINUTE) };
      expect(estPerime(etat, plus(15 * MINUTE), POLITIQUE_CODE)).toBe(true);
    });
  });

  describe('messages', () => {
    it('dit en minutes quand réessayer, arrondi au-dessus', () => {
      expect(messageTropDeTentatives(15 * MINUTE)).toBe(
        'Trop de tentatives. Réessayez dans 15 minutes.',
      );
      expect(messageTropDeTentatives(14 * MINUTE + 1)).toBe(
        'Trop de tentatives. Réessayez dans 15 minutes.',
      );
      expect(messageTropDeTentatives(1)).toBe('Trop de tentatives. Réessayez dans 1 minute.');
      expect(messageTropDeTentatives(60 * MINUTE)).toBe(
        'Trop de tentatives. Réessayez dans 60 minutes.',
      );
    });

    it('passe en heures au-delà d’une heure', () => {
      expect(messageTropDeTentatives(24 * 60 * MINUTE)).toBe(
        'Trop de tentatives. Réessayez dans 24 heures.',
      );
      expect(messageTropDeTentatives(61 * MINUTE)).toBe(
        'Trop de tentatives. Réessayez dans 2 heures.',
      );
    });

    it('reprend le texte du parcours client pour le délai entre deux envois', () => {
      expect(messageDelaiRenvoi(42)).toBe("Un code vient d'être envoyé. Réessayez dans 42 secondes.");
      expect(messageDelaiRenvoi(1)).toBe("Un code vient d'être envoyé. Réessayez dans 1 seconde.");
    });

    it('n’emploie ni tiret long ni « N/A »', () => {
      const textes = [
        messageTropDeTentatives(15 * MINUTE),
        messageTropDeTentatives(24 * 60 * MINUTE),
        messageDelaiRenvoi(30),
      ];
      for (const texte of textes) {
        expect(texte).not.toMatch(/[\u2013\u2014]|N\/A/);
      }
    });
  });
});
