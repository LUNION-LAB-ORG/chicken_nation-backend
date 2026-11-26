import {
  categorieDuPortefeuille,
  lireCategoriePortefeuille,
  resumePortefeuille,
  type LignePortefeuille,
} from './portefeuille.rules';

const ligne = (partiel: Partial<LignePortefeuille> & { kind: string; status: string }): LignePortefeuille => ({
  amount: null,
  remaining: null,
  points: null,
  ...partiel,
});

describe('categorieDuPortefeuille', () => {
  it('range chaque type dans son onglet', () => {
    expect(categorieDuPortefeuille('POINTS')).toBe('POINTS');
    expect(categorieDuPortefeuille('VOUCHER')).toBe('BONS');
    expect(categorieDuPortefeuille('PROMO_CODE')).toBe('BONS');
    expect(categorieDuPortefeuille('DISH')).toBe('CADEAUX');
    expect(categorieDuPortefeuille('SUPPLEMENT')).toBe('CADEAUX');
  });

  it('garde une carte à gratter dans les cadeaux : son contenu est une surprise', () => {
    expect(categorieDuPortefeuille('MYSTERY')).toBe('CADEAUX');
  });
});

describe('lireCategoriePortefeuille', () => {
  it("lit l'onglet demandé, sans tenir compte de la casse", () => {
    expect(lireCategoriePortefeuille('POINTS')).toBe('POINTS');
    expect(lireCategoriePortefeuille(' bons ')).toBe('BONS');
    expect(lireCategoriePortefeuille('Cadeaux')).toBe('CADEAUX');
  });

  it('rend tout le portefeuille pour une valeur absente ou inconnue (anciennes applis)', () => {
    expect(lireCategoriePortefeuille(undefined)).toBeNull();
    expect(lireCategoriePortefeuille('')).toBeNull();
    expect(lireCategoriePortefeuille('TOUT')).toBeNull();
    expect(lireCategoriePortefeuille(['POINTS'])).toBeNull();
  });
});

describe('resumePortefeuille', () => {
  it('rend des zéros pour un portefeuille vide', () => {
    expect(resumePortefeuille([])).toEqual({
      points: { nombre: 0, total: 0 },
      bons: { nombre: 0, disponibles: 0, valeur: 0, utilises: 0 },
      cadeaux: { nombre: 0, a_gratter: 0, disponibles: 0, utilises: 0 },
    });
  });

  it('additionne les points crédités et écarte ceux qui ont été annulés', () => {
    const resume = resumePortefeuille([
      ligne({ kind: 'POINTS', status: 'USED', points: 4 }),
      ligne({ kind: 'POINTS', status: 'USED', points: 5 }),
      ligne({ kind: 'POINTS', status: 'EXPIRED', points: 50 }),
    ]);
    expect(resume.points).toEqual({ nombre: 2, total: 9 });
  });

  it('compte les bons : disponibles, valeur restante, utilisés', () => {
    const resume = resumePortefeuille([
      ligne({ kind: 'VOUCHER', status: 'AVAILABLE', amount: 2000, remaining: 2000 }),
      // Bon entamé : il vaut ce qu'il lui reste.
      ligne({ kind: 'VOUCHER', status: 'AVAILABLE', amount: 5000, remaining: 1500 }),
      // Code promo : pas de montant.
      ligne({ kind: 'PROMO_CODE', status: 'AVAILABLE' }),
      ligne({ kind: 'VOUCHER', status: 'USED', amount: 1000, remaining: 0 }),
      ligne({ kind: 'VOUCHER', status: 'EXPIRED', amount: 3000, remaining: 3000 }),
    ]);
    expect(resume.bons).toEqual({ nombre: 5, disponibles: 3, valeur: 3500, utilises: 1 });
  });

  it('compte les cadeaux : à gratter, disponibles, utilisés', () => {
    const resume = resumePortefeuille([
      ligne({ kind: 'MYSTERY', status: 'TO_SCRATCH' }),
      ligne({ kind: 'MYSTERY', status: 'TO_SCRATCH' }),
      ligne({ kind: 'DISH', status: 'AVAILABLE', amount: 3500 }),
      ligne({ kind: 'SUPPLEMENT', status: 'USED' }),
      ligne({ kind: 'DISH', status: 'EXPIRED' }),
    ]);
    expect(resume.cadeaux).toEqual({ nombre: 5, a_gratter: 2, disponibles: 1, utilises: 1 });
  });

  it("ne mélange pas les onglets : le prix d'un plat offert n'est pas une valeur de bon", () => {
    const resume = resumePortefeuille([
      ligne({ kind: 'DISH', status: 'AVAILABLE', amount: 3500 }),
      ligne({ kind: 'POINTS', status: 'USED', points: 3 }),
    ]);
    expect(resume.bons).toEqual({ nombre: 0, disponibles: 0, valeur: 0, utilises: 0 });
    expect(resume.points.total).toBe(3);
  });
});
