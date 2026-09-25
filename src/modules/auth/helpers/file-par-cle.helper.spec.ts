import { FileParCle, avantDelai } from './file-par-cle.helper';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FileParCle', () => {
  it('fait passer les tâches d’une même clé une par une, dans l’ordre', async () => {
    const file = new FileParCle();
    const journal: string[] = [];
    let enCours = 0;
    let maximum = 0;
    const tache = (nom: string) => async () => {
      enCours++;
      maximum = Math.max(maximum, enCours);
      journal.push(`début ${nom}`);
      await pause(5);
      journal.push(`fin ${nom}`);
      enCours--;
      return nom;
    };

    const resultats = await Promise.all([
      file.executer('a', tache('1')),
      file.executer('a', tache('2')),
      file.executer('a', tache('3')),
    ]);

    expect(resultats).toEqual(['1', '2', '3']);
    expect(maximum).toBe(1);
    expect(journal).toEqual(['début 1', 'fin 1', 'début 2', 'fin 2', 'début 3', 'fin 3']);
  });

  it('laisse des clés différentes avancer en même temps', async () => {
    const file = new FileParCle();
    let enCours = 0;
    let maximum = 0;
    const tache = async () => {
      enCours++;
      maximum = Math.max(maximum, enCours);
      await pause(5);
      enCours--;
    };

    await Promise.all([file.executer('a', tache), file.executer('b', tache)]);

    expect(maximum).toBe(2);
  });

  it('transmet l’erreur d’une tâche sans bloquer la suivante', async () => {
    const file = new FileParCle();
    const echec = file.executer('a', async () => {
      throw new Error('refus');
    });
    const suivante = file.executer('a', async () => 'ok');

    await expect(echec).rejects.toThrow('refus');
    await expect(suivante).resolves.toBe('ok');
  });

  it('libère la clé quand sa file est vide', async () => {
    const file = new FileParCle();
    await Promise.allSettled([
      file.executer('a', async () => 1),
      file.executer('a', async () => {
        throw new Error('refus');
      }),
      file.executer('b', async () => 2),
    ]);
    expect(file.taille).toBe(0);
  });
});

describe('avantDelai', () => {
  it('rend le résultat d’une promesse à l’heure', async () => {
    await expect(avantDelai(Promise.resolve('valeur'), 50)).resolves.toBe('valeur');
  });

  it('transmet l’erreur de la promesse', async () => {
    await expect(avantDelai(Promise.reject(new Error('panne')), 50)).rejects.toThrow('panne');
  });

  it('rejette une promesse qui ne répond pas', async () => {
    const jamais = new Promise<never>(() => undefined);
    await expect(avantDelai(jamais, 20)).rejects.toThrow('délai de 20 ms dépassé');
  });
});
