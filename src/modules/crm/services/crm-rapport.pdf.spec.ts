import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rapportFictif } from './crm-rapport.fixture';
import { dessinerRapport, echelleAxe } from './crm-rapport.pdf';
import { phrasesARetenir } from './crm-rapport.rules';

/**
 * Rendu du PDF sur un rapport fictif. Les fichiers sont écrits dans
 * `RAPPORT_CRM_DIR` (ou le dossier temporaire) pour le contrôle visuel :
 * convertir chaque page en PNG et REGARDER, c'est la seule façon de juger
 * une mise en page.
 */
const DOSSIER = process.env.RAPPORT_CRM_DIR ?? join(tmpdir(), 'rapport-crm');
const FINE = ' ';
const TIRETS = /[–—]/;

describe('dessinerRapport', () => {
  beforeAll(() => mkdirSync(DOSSIER, { recursive: true }));

  it.each([7, 60] as const)('dessine un PDF propre sur %s jours', async (jours) => {
    const r = rapportFictif(jours);
    r.a_retenir = phrasesARetenir(r);
    const chaines: string[] = [];
    const pdf = await dessinerRapport(r, { surChaine: (s) => chaines.push(s) });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000);
    expect(chaines.length).toBeGreaterThan(100);
    for (const s of chaines) {
      expect(s).not.toContain(FINE);
      expect(s).not.toMatch(TIRETS);
      expect(s).not.toMatch(/N\/A/);
    }
    // Les chiffres de l'écran sont bien dans le document, écrits à la française.
    expect(chaines).toContain('133 070 F');
    expect(chaines).toContain('Page 1 sur ' + (jours === 7 ? '3' : '3'));
    writeFileSync(join(DOSSIER, `rapport-${jours}j.pdf`), pdf);
  });

  it('précise « et N autres agents » au-delà de 12 lignes', async () => {
    const r = rapportFictif(60);
    r.a_retenir = phrasesARetenir(r);
    const chaines: string[] = [];
    await dessinerRapport(r, { surChaine: (s) => chaines.push(s) });
    expect(chaines).toContain('et 2 autres agents');
  });

  it('grise une section hors du filtre et note le réseau entier pour un restaurant', async () => {
    const r = rapportFictif(7);
    r.captes.hors_filtre = true;
    r.inscriptions.hors_restaurant = true;
    r.filtres.restaurant = { id: 'r1', nom: 'Chicken Nation Angré' };
    r.filtres.publics = ['JAMAIS_COMMANDE', 'INACTIF'];
    r.a_retenir = phrasesARetenir(r);
    const chaines: string[] = [];
    const pdf = await dessinerRapport(r, { surChaine: (s) => chaines.push(s) });
    expect(chaines).toContain('hors du filtre');
    expect(chaines.some((s) => s.includes('tout le réseau'))).toBe(true);
    expect(chaines.some((s) => s.includes('Restaurant : Chicken Nation Angré'))).toBe(true);
    writeFileSync(join(DOSSIER, 'rapport-7j-restaurant.pdf'), pdf);
  });

  it('nomme et colore la section du seul public couvert, sans ligne « hors du filtre » dans le tableau', async () => {
    const r = rapportFictif(7);
    r.filtres.publics = ['YANGO'];
    r.captes.par_public[0].hors_filtre = true;
    r.a_retenir = phrasesARetenir(r);
    const chaines: string[] = [];
    const pdf = await dessinerRapport(r, { surChaine: (s) => chaines.push(s) });
    writeFileSync(join(DOSSIER, 'rapport-7j-yango.pdf'), pdf);
    expect(chaines).toContain('Yango');
    expect(chaines).not.toContain('Glovo et Yango');
    expect(chaines).not.toContain('hors du filtre');
    // Un seul public : pas de tableau « Par public » dans la section (celui du résultat reste).
    expect(chaines.filter((s) => s === 'Par public')).toHaveLength(1);
  });

  it('écrit « stable », « points » et « Clients revenus », jamais « pts »', async () => {
    const r = rapportFictif(7);
    r.a_retenir = phrasesARetenir(r);
    const chaines: string[] = [];
    await dessinerRapport(r, { surChaine: (s) => chaines.push(s) });
    expect(chaines).toContain('stable');
    expect(chaines).toContain('+3,4\u00A0points');
    expect(chaines).toContain('+1\u00A0point');
    expect(chaines.some((s) => /\bpts?$/.test(s))).toBe(false);
    expect(chaines).toContain('Clients revenus');
    expect(chaines).toContain('Taux de contact (joints / clients appelés)');
    expect(chaines).toContain('Clients appelés');
  });

  it('ne plante jamais sur un rapport vide', async () => {
    const r = rapportFictif(7);
    r.equipe.agents = [];
    r.raisons = [];
    r.inscriptions.serie = [];
    r.a_retenir = [];
    const pdf = await dessinerRapport(r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('echelleAxe', () => {
  it('choisit un pas rond et un plafond qui colle au maximum', () => {
    expect(echelleAxe(212)).toEqual({ pas: 50, plafond: 250 });
    expect(echelleAxe(92)).toEqual({ pas: 20, plafond: 100 });
    expect(echelleAxe(9)).toEqual({ pas: 2, plafond: 10 });
    expect(echelleAxe(3)).toEqual({ pas: 1, plafond: 4 });
    expect(echelleAxe(1_240)).toEqual({ pas: 500, plafond: 1_500 });
  });
});
