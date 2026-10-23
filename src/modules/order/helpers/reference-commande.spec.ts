import { referenceCommandeLibre } from './reference-commande';

describe('référence de commande libre (banc du 23/10 : 409 « reference existe déjà »)', () => {
  const suite = (...valeurs: string[]) => {
    let i = 0;
    return () => valeurs[Math.min(i++, valeurs.length - 1)];
  };

  it('référence libre : gardée telle quelle, une seule lecture', async () => {
    const existe = jest.fn(async () => false);
    await expect(referenceCommandeLibre(suite('ORD-261023-11111'), existe)).resolves.toBe('ORD-261023-11111');
    expect(existe).toHaveBeenCalledTimes(1);
  });

  it('référence déjà prise : une autre est tirée', async () => {
    const prises = new Set(['ORD-261023-11111', 'ORD-261023-22222']);
    const ref = await referenceCommandeLibre(
      suite('ORD-261023-11111', 'ORD-261023-22222', 'ORD-261023-33333'),
      async (r) => prises.has(r),
    );
    expect(ref).toBe('ORD-261023-33333');
  });

  it('lecture en échec : la référence tirée est gardée, la commande n’est jamais bloquée', async () => {
    const ref = await referenceCommandeLibre(suite('ORD-261023-44444'), async () => {
      throw new Error('base indisponible');
    });
    expect(ref).toBe('ORD-261023-44444');
  });

  it('jamais plus de 8 tirages', async () => {
    const generer = jest.fn(() => 'ORD-261023-55555');
    await referenceCommandeLibre(generer, async () => true);
    expect(generer).toHaveBeenCalledTimes(8);
  });
});
