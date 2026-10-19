/**
 * Évaluation en mémoire d'un `where` Prisma, avec la logique à trois valeurs
 * de SQL : une comparaison avec une colonne vide (NULL) n'est ni vraie ni
 * fausse, et la ligne n'est pas rendue. C'est le piège de
 * `channel: { not: 'WEB' }`, écrit `channel <> 'WEB'`, qui écarte les
 * commandes sans canal.
 *
 * Les bases simulées des autres tests (relance, réductions) traitent `not`
 * comme en JavaScript : elles ne verraient pas ce piège.
 *
 * Seul le sous-ensemble employé par les filtres des commandes est pris en
 * charge (AND, OR, NOT, null, equals, not, in, gte, gt, lte, lt) ; un autre
 * opérateur lève, pour qu'un test ne passe jamais par oubli.
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 */

type Ligne = Record<string, unknown>;

/** `null` : inconnu (UNKNOWN de SQL). */
type Verdict = boolean | null;

const et = (verdicts: Verdict[]): Verdict =>
  verdicts.some((v) => v === false) ? false : verdicts.some((v) => v === null) ? null : true;

const ou = (verdicts: Verdict[]): Verdict =>
  verdicts.some((v) => v === true) ? true : verdicts.some((v) => v === null) ? null : false;

const non = (v: Verdict): Verdict => (v === null ? null : !v);

const vide = (v: unknown) => v === null || v === undefined;

const enListe = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

const valeurDe = (v: unknown) => (v instanceof Date ? v.getTime() : v);

function comparer(valeur: unknown, operateur: string, attendu: unknown): Verdict {
  if (vide(valeur) || vide(attendu)) return null;
  const a = valeurDe(valeur) as number | string | boolean;
  const b = valeurDe(attendu) as number | string | boolean;
  switch (operateur) {
    case 'equals':
      return a === b;
    case 'gte':
      return a >= b;
    case 'gt':
      return a > b;
    case 'lte':
      return a <= b;
    case 'lt':
      return a < b;
    default:
      throw new Error(`Opérateur non pris en charge : ${operateur}`);
  }
}

function evaluerChamp(valeur: unknown, condition: unknown): Verdict {
  if (condition === null) return vide(valeur); // IS NULL
  if (condition instanceof Date || typeof condition !== 'object') {
    return comparer(valeur, 'equals', condition);
  }
  const verdicts: Verdict[] = [];
  for (const [operateur, attendu] of Object.entries(condition as Ligne)) {
    if (attendu === undefined) continue;
    if (operateur === 'not') {
      if (attendu !== null && typeof attendu === 'object' && !(attendu instanceof Date)) {
        throw new Error('`not` imbriqué non pris en charge');
      }
      // { not: null } : IS NOT NULL. Sinon `<>`, inconnu sur une colonne vide.
      verdicts.push(attendu === null ? !vide(valeur) : non(comparer(valeur, 'equals', attendu)));
    } else if (operateur === 'in') {
      verdicts.push(vide(valeur) ? null : (attendu as unknown[]).some((x) => comparer(valeur, 'equals', x)));
    } else if (operateur === 'equals' && attendu === null) {
      verdicts.push(vide(valeur));
    } else {
      verdicts.push(comparer(valeur, operateur, attendu));
    }
  }
  return et(verdicts);
}

function evaluer(ligne: Ligne, where: Ligne): Verdict {
  const verdicts: Verdict[] = [];
  for (const [cle, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (cle === 'AND') {
      verdicts.push(et(enListe(condition as Ligne | Ligne[]).map((c) => evaluer(ligne, c))));
    } else if (cle === 'OR') {
      verdicts.push(ou((condition as Ligne[]).map((c) => evaluer(ligne, c))));
    } else if (cle === 'NOT') {
      verdicts.push(et(enListe(condition as Ligne | Ligne[]).map((c) => non(evaluer(ligne, c)))));
    } else {
      verdicts.push(evaluerChamp(ligne[cle], condition));
    }
  }
  return et(verdicts);
}

/** La ligne est-elle rendue par ce `where`, comme en base ? */
export function rendueParLaBase(ligne: Ligne, where: object): boolean {
  return evaluer(ligne, where as Ligne) === true;
}
