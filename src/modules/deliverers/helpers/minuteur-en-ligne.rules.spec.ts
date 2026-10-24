/**
 * Minuteur « en ligne » (demande du 24/10) : règle pure et script Redis.
 */
import {
  DUREE_VIE_MINUTEUR_S,
  EtatMinuteur,
  SCRIPT_AVANCER_MINUTEUR,
  avancerMinuteur,
  cleMinuteurEnLigne,
  ecartMaxMinuteurMs,
  estEnLigne,
  lireEtatMinuteur,
  secondesEnLigne,
} from './minuteur-en-ligne.rules';
import { RedisMinuteurSimule, SCRIPT_TRANSCRIT } from './minuteur-en-ligne.redis-simule-spec';

const T0 = new Date('2026-10-24T10:00:00.000Z').getTime();
const s = (secondes: number) => T0 + secondes * 1000;
const ECART = 180_000;
const enLigne = (a: number) => ({ a, enLigneJusquIci: true, enLigneDesormais: true });
const horsLigne = (a: number) => ({ a, enLigneJusquIci: false, enLigneDesormais: false });

/** Applique une suite de signes de vie à la règle. */
const appliquer = (signaux: ReturnType<typeof enLigne>[], ecart = ECART): EtatMinuteur | null =>
  signaux.reduce<EtatMinuteur | null>((e, sig) => avancerMinuteur(e, sig, ecart).etat, null);

describe('avancerMinuteur', () => {
  it('signes de vie toutes les 60 s pendant 10 min : 600 s', () => {
    const e = appliquer(Array.from({ length: 11 }, (_, i) => enLigne(s(i * 60))));
    expect(e?.ms).toBe(600_000);
  });

  it('premier signe de vie : rien de compté, il ouvre le compte', () => {
    expect(avancerMinuteur(null, enLigne(s(0)), ECART)).toEqual({
      etat: { ms: 0, dernier: s(0), en_ligne: true },
      ajoutMs: 0,
    });
  });

  it('trou de 10 min (connexion coupée, appli fermée) : pas compté, le compte reprend ensuite', () => {
    const e = appliquer([enLigne(s(0)), enLigne(s(60)), enLigne(s(660)), enLigne(s(720))]);
    expect(e?.ms).toBe(120_000);
  });

  it('écart égal au réglage : compté ; une seconde de plus : pas compté', () => {
    expect(appliquer([enLigne(s(0)), enLigne(s(180))])?.ms).toBe(180_000);
    expect(appliquer([enLigne(s(0)), enLigne(s(181))])?.ms).toBe(0);
  });

  it('en pause aux deux bouts ou à un seul : pas compté', () => {
    expect(appliquer([horsLigne(s(0)), horsLigne(s(60))])?.ms).toBe(0);
    expect(appliquer([enLigne(s(0)), horsLigne(s(60)), enLigne(s(120))])?.ms).toBe(0);
  });

  it('changement d’état : compté jusqu’à l’instant du changement selon l’état d’avant', () => {
    const pause = { a: s(90), enLigneJusquIci: true, enLigneDesormais: false };
    const reprise = { a: s(400), enLigneJusquIci: true, enLigneDesormais: true };
    const e = appliquer([enLigne(s(0)), enLigne(s(60)), pause, horsLigne(s(120)), horsLigne(s(180)), reprise, enLigne(s(460))]);
    expect(e?.ms).toBe(90_000 + 60_000);
  });

  it('même signe de vie reçu deux fois, ou en retard : ignoré', () => {
    const e = appliquer([enLigne(s(0)), enLigne(s(60)), enLigne(s(60)), enLigne(s(30)), enLigne(s(120))]);
    expect(e?.ms).toBe(120_000);
    expect(avancerMinuteur({ ms: 5, dernier: s(60), en_ligne: true }, horsLigne(s(60)), ECART)).toEqual({
      etat: { ms: 5, dernier: s(60), en_ligne: true },
      ajoutMs: 0,
    });
  });
});

describe('secondesEnLigne (lecture)', () => {
  const etat: EtatMinuteur = { ms: 60_500, dernier: s(60), en_ligne: true };

  it('ajoute l’écart en cours s’il sera compté au prochain signe de vie', () => {
    expect(secondesEnLigne(etat, s(90), true, ECART)).toBe(90);
  });

  it('en pause maintenant, ou silence trop long : seulement le temps compté', () => {
    expect(secondesEnLigne(etat, s(90), false, ECART)).toBe(60);
    expect(secondesEnLigne(etat, s(60 + 181), true, ECART)).toBe(60);
    expect(secondesEnLigne({ ...etat, en_ligne: false }, s(90), true, ECART)).toBe(60);
  });

  it('aucun compteur : 0', () => {
    expect(secondesEnLigne(null, s(0), true, ECART)).toBe(0);
  });
});

describe('cleMinuteurEnLigne : journée de service de 05 h à 05 h', () => {
  it('04 h 59 appartient à la veille, 05 h 00 au nouveau jour', () => {
    expect(cleMinuteurEnLigne('l1', new Date('2026-10-25T04:59:59.999Z'))).toBe('livreur:en-ligne:l1:2026-10-24');
    expect(cleMinuteurEnLigne('l1', new Date('2026-10-25T05:00:00.000Z'))).toBe('livreur:en-ligne:l1:2026-10-25');
    expect(cleMinuteurEnLigne('l1', new Date('2026-10-25T23:30:00.000Z'))).toBe('livreur:en-ligne:l1:2026-10-25');
  });
});

describe('estEnLigne', () => {
  const M = new Date(s(0));
  const futur = new Date(s(600));
  const passe = new Date(s(-600));

  it('en service hors pause : oui ; en course sorti de la file : oui', () => {
    expect(estEnLigne({ pause_until: null, auto_pause_until: null, last_available_at: passe }, false, M)).toBe(true);
    expect(estEnLigne({ pause_until: null, auto_pause_until: null, last_available_at: null }, true, M)).toBe(true);
    expect(estEnLigne({ pause_until: passe, auto_pause_until: passe, last_available_at: passe }, false, M)).toBe(true);
  });

  it('en pause, en pause automatique ou hors service : non', () => {
    expect(estEnLigne({ pause_until: futur, auto_pause_until: null, last_available_at: null }, true, M)).toBe(false);
    expect(estEnLigne({ pause_until: null, auto_pause_until: futur, last_available_at: passe }, false, M)).toBe(false);
    expect(estEnLigne({ pause_until: null, auto_pause_until: null, last_available_at: null }, false, M)).toBe(false);
  });
});

describe('réglage et lecture Redis', () => {
  it('écart le plus long : le réglage, ou 180 s quand la règle de l’appli est coupée (0)', () => {
    expect(ecartMaxMinuteurMs(120)).toBe(120_000);
    expect(ecartMaxMinuteurMs(0)).toBe(180_000);
  });

  it('compteur lu : champs absents ou illisibles', () => {
    expect(lireEtatMinuteur([null, null, null])).toBeNull();
    expect(lireEtatMinuteur([null, String(s(0)), '1'])).toEqual({ ms: 0, dernier: s(0), en_ligne: true });
    expect(lireEtatMinuteur(['1200', String(s(0)), '0'])).toEqual({ ms: 1200, dernier: s(0), en_ligne: false });
  });
});

describe('script Redis : même résultat que la règle', () => {
  it('le script de production est celui que le simulateur transcrit (un changement du Lua casse ce test)', () => {
    expect(SCRIPT_AVANCER_MINUTEUR).toBe(SCRIPT_TRANSCRIT);
  });

  it('suites de signes de vie au hasard (retards, doublons, pauses, trous)', async () => {
    let graine = 7;
    const hasard = () => {
      graine = (graine * 1103515245 + 12345) % 2 ** 31;
      return graine / 2 ** 31;
    };
    for (let essai = 0; essai < 40; essai++) {
      const redis = new RedisMinuteurSimule();
      let etat: EtatMinuteur | null = null;
      let t = s(0);
      for (let i = 0; i < 60; i++) {
        t += Math.floor(hasard() * 260_000) - 20_000;
        const sig = { a: t, enLigneJusquIci: hasard() > 0.2, enLigneDesormais: hasard() > 0.2 };
        const attendu = avancerMinuteur(etat, sig, ECART);
        etat = attendu.etat;
        const ajout = await redis.eval(
          SCRIPT_AVANCER_MINUTEUR,
          1,
          'cle',
          String(sig.a),
          sig.enLigneJusquIci ? '1' : '0',
          sig.enLigneDesormais ? '1' : '0',
          String(ECART),
          String(DUREE_VIE_MINUTEUR_S),
        );
        expect(ajout).toBe(attendu.ajoutMs);
        expect(lireEtatMinuteur(await redis.hmget('cle', 'ms', 'dernier', 'en_ligne'))).toEqual(etat);
      }
    }
  });
});
