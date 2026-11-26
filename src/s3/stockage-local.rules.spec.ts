import { adresseStockageLocal } from './stockage-local.rules';

describe('adresseStockageLocal', () => {
  it('accepte une adresse du poste', () => {
    expect(adresseStockageLocal('http://127.0.0.1:4098')).toBe('http://127.0.0.1:4098');
    expect(adresseStockageLocal('http://localhost:4098/')).toBe('http://localhost:4098');
    expect(adresseStockageLocal('  http://127.0.0.1:9  ')).toBe('http://127.0.0.1:9');
  });

  it('ignore une valeur vide ou absente : la production parle à Amazon', () => {
    expect(adresseStockageLocal(undefined)).toBeNull();
    expect(adresseStockageLocal(null)).toBeNull();
    expect(adresseStockageLocal('')).toBeNull();
    expect(adresseStockageLocal('""')).toBeNull();
  });

  it("ignore toute adresse qui n'est pas celle du poste", () => {
    expect(adresseStockageLocal('https://s3.eu-west-3.amazonaws.com')).toBeNull();
    expect(adresseStockageLocal('http://10.0.0.5:9000')).toBeNull();
    expect(adresseStockageLocal('http://127.0.0.1.exemple.com')).toBeNull();
    expect(adresseStockageLocal('http://localhost:4098/autre')).toBeNull();
    expect(adresseStockageLocal('https://127.0.0.1:4098')).toBeNull();
  });
});
