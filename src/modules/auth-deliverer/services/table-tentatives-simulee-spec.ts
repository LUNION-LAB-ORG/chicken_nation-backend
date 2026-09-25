/**
 * Table OtpVerificationAttempt simulée en mémoire, pour les tests.
 *
 * Nom en « -spec.ts » : exclu de la construction (tsconfig.build.json écarte
 * tout fichier dont le nom finit par « spec.ts ») sans être pris pour une
 * suite par Jest (qui ne retient que les noms en « .spec.ts »).
 *
 * Chaque requête rend la main une fois avant de s'exécuter, comme un aller et
 * retour vers la base : des appels lancés ensemble s'entrelacent entre deux
 * requêtes. Une requête, elle, s'exécute d'un bloc, comme l'upsert natif de
 * PostgreSQL : c'est ce qui rend l'incrément atomique.
 */

export interface LigneTentatives {
  id: string;
  phone: string;
  failed_count: number;
  window_start: Date;
  locked_until: Date | null;
  updated_at: Date;
}

type Condition = Record<string, unknown>;

function correspond(ligne: LigneTentatives, where: Condition): boolean {
  for (const [champ, attendu] of Object.entries(where)) {
    if (champ === 'OR') {
      if (!(attendu as Condition[]).some((c) => correspond(ligne, c))) return false;
      continue;
    }
    const valeur = (ligne as unknown as Record<string, unknown>)[champ];
    if (attendu === null) {
      if (valeur !== null) return false;
      continue;
    }
    if (typeof attendu !== 'object' || attendu instanceof Date) {
      if (valeur !== attendu) return false;
      continue;
    }
    const op = attendu as { in?: unknown[]; lt?: Date; lte?: Date };
    if (op.in && !op.in.includes(valeur)) return false;
    // Comme en SQL : une comparaison avec NULL n'est jamais vraie.
    if (op.lt && !(valeur instanceof Date && valeur.getTime() < op.lt.getTime())) return false;
    if (op.lte && !(valeur instanceof Date && valeur.getTime() <= op.lte.getTime())) return false;
  }
  return true;
}

// Une microtâche suffit : les appels lancés ensemble (Promise.all) atteignent
// tous leur première requête avant qu'aucune ne s'exécute. Pas de minuteur,
// donc rien qui retienne Jest à la fin.
const allerRetour = () => Promise.resolve();

export function creerTableTentativesSimulee() {
  const lignes = new Map<string, LigneTentatives>();
  let suivant = 1;

  const table = {
    findUnique: jest.fn(async ({ where }: { where: { phone: string } }) => {
      await allerRetour();
      const ligne = lignes.get(where.phone);
      return ligne ? { ...ligne } : null;
    }),

    findMany: jest.fn(async ({ where }: { where: Condition }) => {
      await allerRetour();
      return [...lignes.values()].filter((ligne) => correspond(ligne, where)).map((l) => ({ ...l }));
    }),

    updateMany: jest.fn(
      async ({ where, data }: { where: Condition; data: Partial<LigneTentatives> }) => {
        await allerRetour();
        let count = 0;
        for (const ligne of lignes.values()) {
          if (!correspond(ligne, where)) continue;
          Object.assign(ligne, data, { updated_at: new Date() });
          count++;
        }
        return { count };
      },
    ),

    upsert: jest.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { phone: string };
        create: { phone: string; failed_count: number; window_start: Date };
        update: { failed_count: { increment: number } };
      }) => {
        await allerRetour();
        const existante = lignes.get(where.phone);
        if (existante) {
          existante.failed_count += update.failed_count.increment;
          existante.updated_at = new Date();
          return { ...existante };
        }
        const ligne: LigneTentatives = {
          id: `ligne-${suivant++}`,
          phone: create.phone,
          failed_count: create.failed_count,
          window_start: create.window_start,
          locked_until: null,
          updated_at: new Date(),
        };
        lignes.set(ligne.phone, ligne);
        return { ...ligne };
      },
    ),

    deleteMany: jest.fn(async ({ where }: { where: Condition }) => {
      await allerRetour();
      let count = 0;
      for (const [cle, ligne] of [...lignes.entries()]) {
        if (!correspond(ligne, where)) continue;
        lignes.delete(cle);
        count++;
      }
      return { count };
    }),
  };

  return { table, lignes };
}
