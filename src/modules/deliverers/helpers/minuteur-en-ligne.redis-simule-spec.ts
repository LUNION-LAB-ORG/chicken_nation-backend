/**
 * Redis simulé pour le minuteur « en ligne » : partagé par plusieurs
 * serveurs simulés, il exécute le script Lua d'un bloc, comme Redis. Le
 * script y est transcrit ligne à ligne (valeurs en chaînes, champs absents),
 * indépendamment de `avancerMinuteur` : les tests de la règle vérifient que
 * les deux disent la même chose.
 *
 * La transcription vaut pour CE texte du script (`SCRIPT_TRANSCRIT`), figé
 * ici, et non pour la constante de production importée : un script de
 * production modifié (`<=` devenu `<`, HINCRBY oublié) ne correspond plus et
 * le simulateur refuse de l'exécuter. Il faut alors refaire la transcription
 * et ce texte ensemble (relecture du 24/10 : la suite comparait la constante
 * à elle-même et restait verte).
 */
export const SCRIPT_TRANSCRIT = `
local etat = redis.call('HMGET', KEYS[1], 'ms', 'dernier', 'en_ligne')
local a = tonumber(ARGV[1])
local dernier = tonumber(etat[2])
if dernier and a <= dernier then
  return 0
end
local ajout = 0
if dernier and etat[3] == '1' and ARGV[2] == '1' and a - dernier <= tonumber(ARGV[4]) then
  ajout = a - dernier
  redis.call('HINCRBY', KEYS[1], 'ms', ajout)
end
redis.call('HSET', KEYS[1], 'dernier', ARGV[1], 'en_ligne', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return ajout
`;

/** Lecture groupée (vue Livreurs « Aujourd'hui ») : texte figé de la même façon. */
export const SCRIPT_LIRE_TRANSCRIT = `
local sortie = {}
for i, cle in ipairs(KEYS) do
  sortie[i] = redis.call('HMGET', cle, 'ms', 'dernier', 'en_ligne')
end
return sortie
`;

export class RedisMinuteurSimule {
  readonly hachages = new Map<string, Map<string, string>>();
  readonly durees = new Map<string, number>();
  panne = false;
  scriptsRecus = 0;
  lecturesGroupees = 0;

  async eval(script: string, nombreCles: number, cle: string, ...argv: string[]): Promise<number | (string | null)[][]> {
    if (this.panne) throw new Error('Connection is closed.');
    if (script === SCRIPT_LIRE_TRANSCRIT) {
      // for i, cle in ipairs(KEYS) do sortie[i] = redis.call('HMGET', cle, 'ms', 'dernier', 'en_ligne') end
      this.lecturesGroupees += 1;
      return [cle, ...argv].slice(0, nombreCles).map((k) => {
        const h = this.hachages.get(k);
        return ['ms', 'dernier', 'en_ligne'].map((c) => h?.get(c) ?? null);
      });
    }
    if (script !== SCRIPT_TRANSCRIT || nombreCles !== 1) {
      throw new Error('script Lua inattendu : refaire la transcription du simulateur (SCRIPT_TRANSCRIT, SCRIPT_LIRE_TRANSCRIT)');
    }
    this.scriptsRecus += 1;
    const h = this.hachages.get(cle) ?? new Map<string, string>();
    // local etat = redis.call('HMGET', KEYS[1], 'ms', 'dernier', 'en_ligne')
    const etat = [h.get('ms') ?? false, h.get('dernier') ?? false, h.get('en_ligne') ?? false];
    // local a = tonumber(ARGV[1]) ; local dernier = tonumber(etat[2])
    const a = Number(argv[0]);
    const dernier = etat[1] === false ? null : Number(etat[1]);
    // if dernier and a <= dernier then return 0 end
    if (dernier !== null && a <= dernier) return 0;
    let ajout = 0;
    // if dernier and etat[3] == '1' and ARGV[2] == '1' and a - dernier <= tonumber(ARGV[4]) then
    if (dernier !== null && etat[2] === '1' && argv[1] === '1' && a - dernier <= Number(argv[3])) {
      ajout = a - dernier;
      // redis.call('HINCRBY', KEYS[1], 'ms', ajout)
      h.set('ms', String(Number(h.get('ms') ?? '0') + ajout));
    }
    // redis.call('HSET', KEYS[1], 'dernier', ARGV[1], 'en_ligne', ARGV[3])
    h.set('dernier', argv[0]);
    h.set('en_ligne', argv[2]);
    this.hachages.set(cle, h);
    // redis.call('EXPIRE', KEYS[1], ARGV[5])
    this.durees.set(cle, Number(argv[4]));
    return ajout;
  }

  async hmget(cle: string, ...champs: string[]): Promise<(string | null)[]> {
    if (this.panne) throw new Error('Connection is closed.');
    const h = this.hachages.get(cle);
    return champs.map((c) => h?.get(c) ?? null);
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}
