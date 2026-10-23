import { JournalLimite, suffixeTues } from './journal-limite.util';

describe('JournalLimite', () => {
  it('une ligne par clé et par fenêtre, le compte des lignes tues ensuite', () => {
    const limite = new JournalLimite(60_000);
    expect(limite.autoriser('a', 0)).toBe(0);
    expect(limite.autoriser('a', 1_000)).toBeNull();
    expect(limite.autoriser('a', 2_000)).toBeNull();
    expect(limite.autoriser('b', 2_000)).toBe(0);
    expect(limite.autoriser('a', 60_000)).toBe(2);
    expect(limite.autoriser('a', 60_001)).toBeNull();
  });

  it('mémoire bornée : les clés passées sont oubliées', () => {
    const limite = new JournalLimite(1_000, 2);
    limite.autoriser('a', 0);
    limite.autoriser('b', 0);
    limite.autoriser('c', 5_000);
    expect((limite as unknown as { cles: Map<string, unknown> }).cles.size).toBe(1);
  });

  it('suffixe lisible', () => {
    expect(suffixeTues(0)).toBe('');
    expect(suffixeTues(1)).toBe(' (et 1 autre)');
    expect(suffixeTues(4)).toBe(' (et 4 autres)');
  });
});
