import { existsSync } from 'fs';
import { join } from 'path';
import * as PDFDocument from 'pdfkit';
import {
  Compare,
  IRapport,
  Levier,
  Taux,
  compter,
  fmtDate,
  fmtDecimal,
  fmtMontant,
  fmtNombre,
  fmtPct,
  fmtVariation,
  libelleDuree,
  libellePrecedente,
  sansFine,
} from './crm-rapport.rules';

/**
 * PDF du rapport « Où en sommes-nous » (A4 portrait, pdfkit).
 *
 * Moderne et sobre : un en-tête, un encadré « À retenir », puis une section
 * par levier avec une bande de titre colorée, des cartes de chiffres
 * comparés, un entonnoir en barres, une courbe des inscriptions, et des
 * tableaux (publics, agents, raisons). Lisible imprimé comme sur téléphone.
 *
 * Règles de mise en page : aucune ligne de tableau ni carte coupée, jamais un
 * titre seul en bas de page, en-tête de tableau répété, pied de page
 * « Page x sur y ». Toutes les chaînes passent par `ecrire`, qui remplace la
 * fine insécable d'Intl (U+202F, que pdfkit coupait en « 32 /479 »).
 */

// ---------------------------------------------------------------------------
// Charte
// ---------------------------------------------------------------------------

const ORANGE = '#F17922';
const ORANGE_PALE = '#FDF3E7';
const ORANGE_FONCE = '#9A3412';
const TEXTE = '#111827';
const GRIS = '#6B7280';
const GRIS_CLAIR = '#9CA3AF';
const FILET = '#E5E7EB';
const FOND_ENTETE = '#F3F4F6';
const ZEBRE = '#F9FAFB';
const VERT = '#16A34A';
const ROUGE = '#DC2626';
const BLANC = '#FFFFFF';

/** Couleurs des publics, celles du backoffice (`COULEUR_PUBLIC`). */
const COULEUR = {
  INSCRITS: '#0EA5E9',
  INACTIF: '#8B5CF6',
  GLOVO: '#10B981',
  YANGO: '#EAB308',
  CAPTES: '#10B981',
  EQUIPE: ORANGE,
  RESULTAT: ORANGE,
  HORS_FILTRE: GRIS_CLAIR,
};

const MARGE = 40;
const PIED = 56;
/** Au plus 12 agents dans le PDF, puis « et N autres agents ». */
const AGENTS_MAX = 12;

/** pdfkit n'a pas de types ici : le document est typé par son constructeur. */
type Doc = InstanceType<typeof PDFDocument>;

interface Options {
  /** Appelé pour chaque chaîne écrite : les tests y vérifient l'absence de fine insécable et de tirets. */
  surChaine?: (s: string) => void;
}

// ---------------------------------------------------------------------------
// Polices et logo : embarqués dans src/assets, repli silencieux
// ---------------------------------------------------------------------------

/** Dossier des ressources, compilé (dist/src/assets) ou source (src/assets). */
function dossierAssets(): string | null {
  const candidats = [
    join(__dirname, '..', '..', '..', 'assets'),
    join(process.cwd(), 'dist', 'src', 'assets'),
    join(process.cwd(), 'src', 'assets'),
  ];
  return candidats.find((c) => existsSync(c)) ?? null;
}

interface Polices {
  texte: string;
  gras: string;
}

/** Urbanist quand elle est là, Helvetica sinon : jamais d'erreur pour une police. */
function enregistrerPolices(doc: Doc): Polices {
  const dossier = dossierAssets();
  const reguliere = dossier ? join(dossier, 'fonts', 'Urbanist-Regular.ttf') : '';
  const grasse = dossier ? join(dossier, 'fonts', 'Urbanist-Bold.ttf') : '';
  try {
    if (reguliere && grasse && existsSync(reguliere) && existsSync(grasse)) {
      doc.registerFont('Texte', reguliere);
      doc.registerFont('Gras', grasse);
      return { texte: 'Texte', gras: 'Gras' };
    }
  } catch {
    // Police illisible : Helvetica fera l'affaire.
  }
  return { texte: 'Helvetica', gras: 'Helvetica-Bold' };
}

function cheminLogo(): string | null {
  const dossier = dossierAssets();
  const chemin = dossier ? join(dossier, 'logo.png') : '';
  return chemin && existsSync(chemin) ? chemin : null;
}

// ---------------------------------------------------------------------------
// Moteur de mise en page
// ---------------------------------------------------------------------------

class Page {
  readonly largeur: number;
  readonly bas: number;
  private readonly polices: Polices;

  constructor(
    readonly doc: Doc,
    private readonly options: Options,
  ) {
    this.largeur = doc.page.width - 2 * MARGE;
    this.bas = doc.page.height - PIED;
    this.polices = enregistrerPolices(doc);
  }

  get y(): number {
    return this.doc.y;
  }
  set y(v: number) {
    this.doc.y = v;
  }

  texte(gras = false): this {
    this.doc.font(gras ? this.polices.gras : this.polices.texte);
    return this;
  }

  /** Il reste `h` points sur la page ; sinon, nouvelle page. */
  assurer(h: number): void {
    if (this.doc.y + h > this.bas) this.doc.addPage();
  }

  /** Une chaîne écrite, propre : fine insécable remplacée, signalée aux tests. */
  ecrire(
    s: string,
    x: number,
    y: number,
    o: { largeur?: number; align?: 'left' | 'right' | 'center'; taille?: number; couleur?: string; gras?: boolean } = {},
  ): void {
    const chaine = sansFine(s);
    this.options.surChaine?.(chaine);
    this.texte(o.gras).doc.fontSize(o.taille ?? 9).fillColor(o.couleur ?? TEXTE);
    this.doc.text(chaine, x, y, { width: o.largeur, align: o.align ?? 'left', lineBreak: false });
  }

  /** Paragraphe qui peut passer à la ligne ; rend sa hauteur. */
  paragraphe(s: string, x: number, y: number, largeur: number, o: { taille?: number; couleur?: string; gras?: boolean } = {}): number {
    const chaine = sansFine(s);
    this.options.surChaine?.(chaine);
    this.texte(o.gras).doc.fontSize(o.taille ?? 9).fillColor(o.couleur ?? TEXTE);
    this.doc.text(chaine, x, y, { width: largeur, align: 'left' });
    return this.doc.y - y;
  }

  hauteurParagraphe(s: string, largeur: number, taille = 9, gras = false): number {
    this.texte(gras).doc.fontSize(taille);
    return this.doc.heightOfString(sansFine(s), { width: largeur });
  }

  largeurTexte(s: string, taille = 9, gras = false): number {
    this.texte(gras).doc.fontSize(taille);
    return this.doc.widthOfString(sansFine(s));
  }

  /** Coupe un texte trop long avec « … », pour qu'il ne sorte jamais de sa colonne. */
  tronquer(s: string, largeur: number, taille = 9, gras = false): string {
    const propre = sansFine(s);
    if (this.largeurTexte(propre, taille, gras) <= largeur) return propre;
    let coupe = propre;
    while (coupe.length > 1 && this.largeurTexte(`${coupe}…`, taille, gras) > largeur) coupe = coupe.slice(0, -1);
    return `${coupe.trimEnd()}…`;
  }

  filet(x1: number, y: number, x2: number, couleur = FILET, epaisseur = 0.5): void {
    this.doc.save().lineWidth(epaisseur).strokeColor(couleur).moveTo(x1, y).lineTo(x2, y).stroke().restore();
  }

  /** Petite flèche pleine : haut (vert) ou bas (rouge). */
  fleche(x: number, y: number, haut: boolean, couleur: string): void {
    const t = 5;
    const points: [number, number][] = haut
      ? [[x, y + t], [x + t, y + t], [x + t / 2, y]]
      : [[x, y], [x + t, y], [x + t / 2, y + t]];
    this.doc.save().polygon(...points).fill(couleur).restore();
  }
}

// ---------------------------------------------------------------------------
// Composants
// ---------------------------------------------------------------------------

function enTete(p: Page, r: IRapport): void {
  const { doc } = p;
  const logo = cheminLogo();
  let x = MARGE;
  if (logo) {
    try {
      doc.image(logo, MARGE, MARGE - 2, { width: 36, height: 36 });
      x = MARGE + 46;
    } catch {
      x = MARGE;
    }
  }
  if (x === MARGE) {
    p.ecrire('Chicken Nation', MARGE, MARGE, { taille: 11, gras: true, couleur: ORANGE });
    doc.y = MARGE + 14;
  }
  p.ecrire('Où en sommes-nous', x, MARGE - 2, { taille: 20, gras: true });
  const periode =
    `Du ${fmtDate(r.periode.debut)} au ${fmtDate(r.periode.fin)} (${libelleDuree(r.periode.jours)}), ` +
    `comparé ${libellePrecedente(r.periode.jours)} (du ${fmtDate(r.precedente.debut)} au ${fmtDate(r.precedente.fin)})`;
  p.ecrire(periode, x, MARGE + 24, { taille: 9, couleur: GRIS, largeur: p.largeur - (x - MARGE) });
  p.ecrire(`Édité le ${fmtDate(r.edite_le)}`, MARGE, MARGE + 2, { taille: 8, couleur: GRIS_CLAIR, largeur: p.largeur, align: 'right' });

  const filtres: string[] = [];
  filtres.push(r.filtres.publics.length ? `Publics : ${r.filtres.publics.map(nomPublic).join(', ')}` : 'Tous les publics');
  if (r.filtres.campagne) filtres.push(`Campagne : ${r.filtres.campagne.nom}`);
  if (r.filtres.restaurant) filtres.push(`Restaurant : ${r.filtres.restaurant.nom}`);
  p.ecrire(p.tronquer(filtres.join('  ·  '), p.largeur - (x - MARGE), 8.5), x, MARGE + 38, { taille: 8.5, couleur: GRIS });

  const yFilet = MARGE + 56;
  p.filet(MARGE, yFilet, MARGE + p.largeur, ORANGE, 2);
  doc.y = yFilet + 14;
}

function nomPublic(code: string): string {
  return { JAMAIS_COMMANDE: 'Inscrits', INACTIF: 'Inactifs', GLOVO: 'Glovo', YANGO: 'Yango' }[code] ?? code;
}

function aRetenir(p: Page, phrases: string[]): void {
  if (!phrases.length) return;
  const { doc } = p;
  const marge = 14;
  const largeurTexte = p.largeur - 2 * marge - 12;
  const hauteurs = phrases.map((s) => p.hauteurParagraphe(s, largeurTexte, 10));
  const hauteur = marge + 14 + hauteurs.reduce((a, h) => a + h + 5, 0) + marge - 5;
  p.assurer(hauteur + 10);
  const y0 = doc.y;
  doc.save().roundedRect(MARGE, y0, p.largeur, hauteur, 8).fill(ORANGE_PALE).restore();
  doc.save().rect(MARGE, y0 + 8, 3, hauteur - 16).fill(ORANGE).restore();
  p.ecrire('À retenir', MARGE + marge, y0 + marge - 2, { taille: 9, gras: true, couleur: ORANGE_FONCE });
  let y = y0 + marge + 14;
  phrases.forEach((s, i) => {
    doc.save().circle(MARGE + marge + 3, y + 5, 2).fill(ORANGE).restore();
    p.paragraphe(s, MARGE + marge + 12, y, largeurTexte, { taille: 10, couleur: TEXTE });
    y += hauteurs[i] + 5;
  });
  doc.y = y0 + hauteur + 18;
}

/** Bande de titre d'une section, jamais seule en bas de page (`reserve` : hauteur du premier bloc). */
function bande(p: Page, titre: string, sousTitre: string, couleur: string, reserve = 90): void {
  const { doc } = p;
  p.assurer(26 + reserve);
  const y = doc.y;
  doc.save().roundedRect(MARGE, y, p.largeur, 24, 4).fill(couleur).restore();
  p.ecrire(titre, MARGE + 10, y + 6.5, { taille: 10.5, gras: true, couleur: BLANC });
  const largeurTitre = p.largeurTexte(titre, 10.5, true);
  const dispo = p.largeur - 20 - largeurTitre - 12;
  if (sousTitre && dispo > 60) {
    p.ecrire(p.tronquer(sousTitre, dispo, 8), MARGE + 10 + largeurTitre + 12, y + 8.5, { taille: 8, couleur: BLANC, largeur: dispo, align: 'right' });
  }
  doc.y = y + 24 + 10;
}

function sectionHorsFiltre(p: Page, titre: string): void {
  bande(p, titre, 'hors du filtre', COULEUR.HORS_FILTRE, 30);
  p.ecrire('Ce public n’est pas dans le filtre de l’écran : rien à lire ici.', MARGE + 2, p.y, { taille: 9, couleur: GRIS });
  p.y += 24;
}

interface Carte {
  libelle: string;
  valeur: string;
  /** Ligne de comparaison : un `Compare`, un `Taux`, ou un texte libre. */
  compare?: Compare | Taux | string;
}

/** Trois ou quatre cartes de chiffres sur une ligne : valeur grande, libellé, comparaison. */
function cartes(p: Page, liste: Carte[]): void {
  const { doc } = p;
  const hauteur = 60;
  const ecart = 8;
  const largeur = (p.largeur - ecart * (liste.length - 1)) / liste.length;
  p.assurer(hauteur + 12);
  const y = doc.y;
  liste.forEach((c, i) => {
    const x = MARGE + i * (largeur + ecart);
    doc.save().roundedRect(x, y, largeur, hauteur, 6).lineWidth(0.6).strokeColor(FILET).stroke().restore();
    p.ecrire(p.tronquer(c.valeur, largeur - 20, 17, true), x + 10, y + 9, { taille: 17, gras: true });
    p.ecrire(p.tronquer(c.libelle, largeur - 20, 8), x + 10, y + 31, { taille: 8, couleur: GRIS });
    ligneComparaison(p, c.compare, x + 10, y + 44, largeur - 20);
  });
  doc.y = y + hauteur + 12;
}

function estCompare(c: Compare | Taux): c is Compare {
  return (c as Compare).comparable !== undefined;
}

/** « ▲ +12 % · 41 avant » en vert, « ▼ -8 % » en rouge, « 41 avant » en gris quand ce n'est pas comparable. */
function ligneComparaison(p: Page, c: Carte['compare'], x: number, y: number, largeur: number): void {
  if (c === undefined) return;
  if (typeof c === 'string') {
    p.ecrire(p.tronquer(c, largeur, 8), x, y, { taille: 8, couleur: GRIS_CLAIR });
    return;
  }
  if (estCompare(c)) {
    const avant = `${c.monnaie ? fmtMontant(c.precedent) : fmtNombre(c.precedent)} avant`;
    if (!c.comparable || c.variation === null) {
      p.ecrire(p.tronquer(avant, largeur, 8), x, y, { taille: 8, couleur: GRIS_CLAIR });
      return;
    }
    evolution(p, c.variation, fmtVariation(c.variation), avant, x, y, largeur);
    return;
  }
  // Un taux : l'écart en points, puis le taux d'avant.
  const ecart = c.ecart_points;
  const etiquette = `${ecart > 0 ? '+' : '-'}${fmtDecimal(Math.abs(ecart))}\u00A0${Math.abs(ecart) >= 2 ? 'points' : 'point'}`;
  evolution(p, ecart, etiquette, `${fmtPct(c.precedent)} avant`, x, y, largeur);
}

/** Flèche et étiquette en vert ou rouge, « stable » en gris quand rien ne bouge (comme à l'écran), puis le chiffre d'avant. */
function evolution(p: Page, sens: number, etiquette: string, avant: string, x: number, y: number, largeur: number): void {
  let dx = x;
  if (sens === 0) {
    p.ecrire('stable', x, y, { taille: 8, gras: true, couleur: GRIS });
    dx += p.largeurTexte('stable', 8, true) + 4;
  } else {
    const couleur = sens > 0 ? VERT : ROUGE;
    p.fleche(x, y + 2, sens > 0, couleur);
    dx += 8;
    p.ecrire(etiquette, dx, y, { taille: 8, gras: true, couleur });
    dx += p.largeurTexte(etiquette, 8, true) + 4;
  }
  p.ecrire(p.tronquer(`· ${avant}`, largeur - (dx - x), 8), dx, y, { taille: 8, couleur: GRIS_CLAIR });
}

interface EtapeEntonnoir {
  libelle: string;
  valeur: number;
}

/**
 * Entonnoir en barres horizontales : longueur proportionnelle à la première
 * étape (plafonnée à la largeur quand un flux la dépasse, le nombre à droite
 * restant exact), et sous chaque libellé le taux par rapport à l'étape
 * précédente.
 */
function entonnoir(p: Page, etapes: EtapeEntonnoir[], couleur: string, titre = 'Entonnoir'): void {
  const { doc } = p;
  const ligne = 24;
  const hauteur = 16 + etapes.length * ligne;
  p.assurer(hauteur + 10);
  const y0 = doc.y;
  p.ecrire(titre, MARGE, y0, { taille: 8, gras: true, couleur: GRIS });
  const colLibelle = 150;
  const colNombre = 56;
  const xBarre = MARGE + colLibelle;
  const largeurMax = p.largeur - colLibelle - colNombre - 8;
  const base = Math.max(1, etapes[0]?.valeur ?? 0);
  etapes.forEach((e, i) => {
    const y = y0 + 16 + i * ligne;
    p.ecrire(p.tronquer(e.libelle, colLibelle - 10, 9, true), MARGE, y + 1, { taille: 9, gras: true });
    if (i > 0) {
      const prec = etapes[i - 1];
      const part = prec.valeur > 0 ? Math.round((e.valeur / prec.valeur) * 1000) / 10 : null;
      // Un flux de la période (appels, coupons, relances) peut dépasser les
      // entrés de la période : le stock d'avant est travaillé aussi.
      const detail =
        part === null ? '' : part > 100 ? 'stock d’avant et relances compris' : `${fmtPct(part)} des ${prec.libelle.toLowerCase()}`;
      if (detail) p.ecrire(p.tronquer(detail, colLibelle - 10, 7), MARGE, y + 12, { taille: 7, couleur: GRIS_CLAIR });
    }
    const largeur = Math.min(largeurMax, Math.max(e.valeur > 0 ? 3 : 0, (e.valeur / base) * largeurMax));
    doc.save().rect(xBarre, y, largeurMax, 13).fill(ZEBRE).restore();
    if (largeur > 0) {
      doc.save().opacity(1 - i * 0.14).roundedRect(xBarre, y, largeur, 13, 2).fill(couleur).restore();
    }
    p.ecrire(fmtNombre(e.valeur), xBarre + largeurMax + 8, y + 1.5, { taille: 9.5, gras: true, largeur: colNombre, align: 'right' });
  });
  doc.y = y0 + hauteur + 10;
}

/** Entonnoir d'un levier : entrés > appelés > joints > coupons > ventes. */
function entonnoirLevier(p: Page, l: Levier, libelles: { entres: string; ventes: string }, couleur: string): void {
  entonnoir(
    p,
    [
      { libelle: libelles.entres, valeur: l.entres.valeur },
      { libelle: 'Appelés', valeur: l.appeles.valeur },
      { libelle: 'Joints', valeur: l.joints.valeur },
      { libelle: 'Coupons envoyés', valeur: l.coupons.valeur },
      { libelle: libelles.ventes, valeur: l.ventes.valeur },
    ],
    couleur,
  );
}

/** Graphique en barres par jour (ou par semaine) : inscrits et premières commandes. */
function courbeInscriptions(p: Page, r: IRapport['inscriptions']): void {
  const { doc } = p;
  if (!r.serie.length) return;
  const hauteurGraphe = 120;
  const hauteur = 16 + hauteurGraphe + 26;
  p.assurer(hauteur + 10);
  const y0 = doc.y;
  const titre = r.pas === 'semaine' ? 'Par semaine' : 'Par jour';
  p.ecrire(titre, MARGE, y0, { taille: 8, gras: true, couleur: GRIS });
  // Légende, à droite.
  let xl = MARGE + p.largeur;
  const legende: [string, string][] = [
    ['Premières commandes', ORANGE],
    ['Inscrits', COULEUR.INSCRITS],
  ];
  for (const [nom, couleur] of legende) {
    const l = p.largeurTexte(nom, 7.5);
    xl -= l;
    p.ecrire(nom, xl, y0 + 0.5, { taille: 7.5, couleur: GRIS });
    xl -= 12;
    doc.save().roundedRect(xl, y0 + 1.5, 8, 7, 1.5).fill(couleur).restore();
    xl -= 14;
  }

  const xAxe = MARGE + 30;
  const largeurGraphe = p.largeur - 30;
  const yHaut = y0 + 18;
  const yBas = yHaut + hauteurGraphe;
  const max = Math.max(1, ...r.serie.map((s) => Math.max(s.inscrits, s.premieres_commandes)));
  const { pas: palier, plafond } = echelleAxe(max);
  // Grille : un filet par palier, le dernier au plafond.
  for (let valeur = 0; valeur <= plafond; valeur += palier) {
    const y = yBas - (valeur / plafond) * hauteurGraphe;
    const i = valeur / palier;
    p.filet(xAxe, y, xAxe + largeurGraphe, i === 0 ? GRIS_CLAIR : FILET, i === 0 ? 0.8 : 0.4);
    p.ecrire(fmtNombre(valeur), MARGE, y - 4, { taille: 7, couleur: GRIS_CLAIR, largeur: 26, align: 'right' });
  }
  const nb = r.serie.length;
  const pas = largeurGraphe / nb;
  const largeurGroupe = Math.min(pas * 0.7, 26);
  const largeurBarre = largeurGroupe / 2;
  const toutesLesN = Math.max(1, Math.ceil(nb / 12));
  r.serie.forEach((s, i) => {
    const xGroupe = xAxe + i * pas + (pas - largeurGroupe) / 2;
    const barre = (valeur: number, dx: number, couleur: string) => {
      const h = (valeur / plafond) * hauteurGraphe;
      if (h > 0) doc.save().rect(xGroupe + dx, yBas - h, largeurBarre, h).fill(couleur).restore();
    };
    barre(s.inscrits, 0, COULEUR.INSCRITS);
    barre(s.premieres_commandes, largeurBarre, ORANGE);
    if (i % toutesLesN === 0 || nb <= 12) {
      const etiquette = r.pas === 'semaine' ? `sem. du ${fmtDate(s.date).slice(0, 5)}` : fmtDate(s.date).slice(0, 5);
      p.ecrire(etiquette, xAxe + i * pas - 10, yBas + 4, { taille: 7, couleur: GRIS, largeur: pas + 20, align: 'center' });
    }
  });
  doc.y = y0 + hauteur + 6;
}

/**
 * Échelle d'un axe : un pas « rond » (1, 2, 5 × 10^k), le plus petit qui
 * tient le maximum en 6 paliers au plus, et un plafond multiple de ce pas,
 * pour que la barre la plus haute frôle le haut du graphique
 * (212 → pas 50, plafond 250 ; 92 → pas 20, plafond 100).
 */
export function echelleAxe(max: number): { pas: number; plafond: number } {
  if (max <= 4) return { pas: 1, plafond: 4 };
  for (let puissance = 1; puissance < 1e9; puissance *= 10) {
    for (const m of [1, 2, 5]) {
      const pas = m * puissance;
      if (Math.ceil(max / pas) <= 6) return { pas, plafond: Math.ceil(max / pas) * pas };
    }
  }
  return { pas: max, plafond: max };
}

interface Colonne {
  titre: string;
  largeur: number;
  align?: 'left' | 'right';
}

/**
 * Tableau : en-tête sur fond gris clair (répété après un saut de page),
 * nombres alignés à droite, lignes alternées, filets fins, texte tronqué.
 */
function tableau(p: Page, colonnes: Colonne[], lignes: string[][], note?: string): void {
  const { doc } = p;
  const hauteurLigne = 18;
  const total = colonnes.reduce((a, c) => a + c.largeur, 0);
  const echelle = p.largeur / total;
  const largeurs = colonnes.map((c) => c.largeur * echelle);

  const enTeteTableau = () => {
    const y = doc.y;
    doc.save().rect(MARGE, y, p.largeur, hauteurLigne).fill(FOND_ENTETE).restore();
    let x = MARGE;
    colonnes.forEach((c, i) => {
      p.ecrire(p.tronquer(c.titre, largeurs[i] - 12, 8, true), x + 6, y + 5, { taille: 8, gras: true, couleur: GRIS, largeur: largeurs[i] - 12, align: c.align ?? 'left' });
      x += largeurs[i];
    });
    doc.y = y + hauteurLigne;
  };

  p.assurer(hauteurLigne * 2 + 4);
  enTeteTableau();
  lignes.forEach((ligne, i) => {
    if (doc.y + hauteurLigne > p.bas) {
      doc.addPage();
      enTeteTableau();
    }
    const y = doc.y;
    if (i % 2 === 1) doc.save().rect(MARGE, y, p.largeur, hauteurLigne).fill(ZEBRE).restore();
    let x = MARGE;
    colonnes.forEach((c, j) => {
      p.ecrire(p.tronquer(ligne[j] ?? '', largeurs[j] - 12, 8.5), x + 6, y + 5, { taille: 8.5, largeur: largeurs[j] - 12, align: c.align ?? 'left' });
      x += largeurs[j];
    });
    p.filet(MARGE, y + hauteurLigne, MARGE + p.largeur);
    doc.y = y + hauteurLigne;
  });
  if (!lignes.length) {
    const y = doc.y;
    p.ecrire('Rien sur la période.', MARGE + 6, y + 5, { taille: 8.5, couleur: GRIS_CLAIR });
    doc.y = y + hauteurLigne;
  }
  if (note) {
    p.ecrire(note, MARGE + 6, doc.y + 4, { taille: 8, couleur: GRIS_CLAIR });
    doc.y += 16;
  }
  doc.y += 10;
}

function pieds(p: Page): void {
  const { doc } = p;
  const plage = doc.bufferedPageRange();
  for (let i = plage.start; i < plage.start + plage.count; i++) {
    doc.switchToPage(i);
    const bas = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    p.filet(MARGE, y - 8, MARGE + p.largeur);
    p.ecrire('Chicken Nation · rapport CRM', MARGE, y, { taille: 7.5, couleur: GRIS_CLAIR });
    p.ecrire(`Page ${i - plage.start + 1} sur ${plage.count}`, MARGE, y, { taille: 7.5, couleur: GRIS_CLAIR, largeur: p.largeur, align: 'right' });
    doc.page.margins.bottom = bas;
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function sectionInscriptions(p: Page, r: IRapport): void {
  const s = r.inscriptions;
  if (s.hors_filtre) return sectionHorsFiltre(p, 'Inscriptions');
  bande(p, 'Inscriptions', 'comptes clients créés sur la période (les lives)', COULEUR.INSCRITS);
  if (s.hors_restaurant) {
    p.ecrire('Les inscrits ne sont rattachés à aucun restaurant : ces chiffres couvrent tout le réseau.', MARGE + 2, p.y, { taille: 8, couleur: GRIS });
    p.y += 14;
  }
  cartes(p, [
    { libelle: 'Inscrits', valeur: fmtNombre(s.inscrits.valeur), compare: s.inscrits },
    { libelle: 'Ont commandé', valeur: fmtNombre(s.ont_commande.valeur), compare: s.ont_commande },
    { libelle: 'Taux de commande', valeur: fmtPct(s.taux_commande.valeur), compare: s.taux_commande },
    { libelle: 'Chiffre d’affaires', valeur: fmtMontant(s.ca.valeur), compare: s.ca },
  ]);
  cartes(p, [
    { libelle: 'Ont commandé sous 7 jours', valeur: fmtNombre(s.sous_7_jours.valeur), compare: s.sous_7_jours },
    {
      libelle: 'Délai médian avant commande',
      valeur: s.delai_median_j === null ? 'aucune' : `${fmtDecimal(s.delai_median_j)}\u00A0j`,
      compare: s.delai_median_j === null ? 'aucune première commande' : 'depuis l’inscription',
    },
    { libelle: 'N’ont pas encore commandé', valeur: fmtNombre(s.sans_commande), compare: `${fmtPct(100 - s.taux_commande.valeur)} des inscrits` },
  ]);
  courbeInscriptions(p, s);
}

function sectionCaptes(p: Page, r: IRapport): void {
  const c = r.captes;
  if (c.hors_filtre) return sectionHorsFiltre(p, 'Glovo et Yango');
  const t = c.total;
  // Un seul public dans le filtre : la section prend son nom et sa couleur.
  const couverts = c.par_public.filter((l) => !l.hors_filtre);
  const titre = couverts.length === 1 ? couverts[0].libelle.replace(/^Clients /, '') : 'Glovo et Yango';
  const couleur = couverts.length === 1 ? COULEUR[couverts[0].segment] : COULEUR.CAPTES;
  bande(p, titre, 'relevés en caisse, à faire commander en direct', couleur);
  cartes(p, [
    { libelle: 'Captés', valeur: fmtNombre(t.entres.valeur), compare: t.entres },
    { libelle: 'Clients joints', valeur: fmtNombre(t.joints.valeur), compare: t.joints },
    { libelle: 'Passés en direct', valeur: fmtNombre(t.ventes.valeur), compare: t.ventes },
    { libelle: 'Chiffre d’affaires', valeur: fmtMontant(t.ca.valeur), compare: t.ca },
  ]);
  cartes(p, [
    { libelle: 'Taux de contact (joints / appelés)', valeur: fmtPct(t.taux_contact.valeur), compare: t.taux_contact },
    { libelle: 'Taux de passage (ventes / captés)', valeur: fmtPct(t.taux_conversion.valeur), compare: t.taux_conversion },
    { libelle: 'Coupons envoyés', valeur: fmtNombre(t.coupons.valeur), compare: t.coupons },
  ]);
  entonnoirLevier(p, t, { entres: 'Captés', ventes: 'Passés en direct' }, couleur);
  if (couverts.length < 2) return;
  p.assurer(18 * (couverts.length + 1) + 24);
  p.ecrire('Par public', MARGE, p.y, { taille: 8, gras: true, couleur: GRIS });
  p.y += 12;
  tableau(
    p,
    [
      { titre: 'Public', largeur: 90 },
      { titre: 'Captés', largeur: 55, align: 'right' },
      { titre: 'Appelés', largeur: 55, align: 'right' },
      { titre: 'Joints', largeur: 55, align: 'right' },
      { titre: 'Coupons', largeur: 55, align: 'right' },
      { titre: 'Passés en direct', largeur: 75, align: 'right' },
      { titre: 'Chiffre d’affaires', largeur: 85, align: 'right' },
      { titre: 'Passage', largeur: 55, align: 'right' },
    ],
    couverts.map((l) => [
      l.libelle,
      fmtNombre(l.entres.valeur),
      fmtNombre(l.appeles.valeur),
      fmtNombre(l.joints.valeur),
      fmtNombre(l.coupons.valeur),
      fmtNombre(l.ventes.valeur),
      fmtMontant(l.ca.valeur),
      fmtPct(l.taux_conversion.valeur),
    ]),
  );
}

function sectionInactifs(p: Page, r: IRapport): void {
  const s = r.inactifs;
  if (s.hors_filtre) return sectionHorsFiltre(p, 'Clients inactifs');
  bande(p, 'Clients inactifs', 'ont déjà commandé, plus rien depuis le délai réglé : à reconquérir', COULEUR.INACTIF);
  cartes(p, [
    { libelle: 'Entrés en inactivité', valeur: fmtNombre(s.entres.valeur), compare: s.entres },
    { libelle: 'Clients joints', valeur: fmtNombre(s.joints.valeur), compare: s.joints },
    { libelle: 'Clients revenus', valeur: fmtNombre(s.ventes.valeur), compare: s.ventes },
    { libelle: 'Chiffre d’affaires', valeur: fmtMontant(s.ca.valeur), compare: s.ca },
  ]);
  cartes(p, [
    { libelle: 'Taux de contact (joints / appelés)', valeur: fmtPct(s.taux_contact.valeur), compare: s.taux_contact },
    { libelle: 'Taux de retour (revenus / entrés)', valeur: fmtPct(s.taux_conversion.valeur), compare: s.taux_conversion },
    {
      libelle: 'Délai médian avant le retour',
      valeur: s.delai_median_j === null ? 'aucun' : `${fmtDecimal(s.delai_median_j)}\u00A0j`,
      compare: s.delai_median_j === null ? 'aucun retour parmi les entrés' : 'depuis l’entrée en inactivité',
    },
  ]);
  entonnoirLevier(p, s, { entres: 'Entrés en inactivité', ventes: 'Clients revenus' }, COULEUR.INACTIF);
}

function sectionEquipe(p: Page, r: IRapport): void {
  const e = r.equipe;
  bande(p, 'Effort de l’équipe', 'appels, clients joints et coupons envoyés sur la période', COULEUR.EQUIPE);
  cartes(p, [
    { libelle: 'Appels passés', valeur: fmtNombre(e.appels.valeur), compare: e.appels },
    { libelle: 'Clients appelés', valeur: fmtNombre(e.appeles.valeur), compare: e.appeles },
    { libelle: 'Clients joints', valeur: fmtNombre(e.joints.valeur), compare: e.joints },
    { libelle: 'Coupons envoyés', valeur: fmtNombre(e.coupons.valeur), compare: e.coupons },
  ]);
  // Le taux se lit sur les clients appelés, pas sur les appels : un client rappelé ne compte qu'une fois.
  const appelsParClient = e.appeles.valeur > 0 ? Math.round((e.appels.valeur / e.appeles.valeur) * 10) / 10 : 0;
  cartes(p, [
    { libelle: 'Taux de contact (joints / clients appelés)', valeur: fmtPct(e.taux_contact.valeur), compare: e.taux_contact },
    {
      libelle: 'Appels par client appelé',
      valeur: fmtDecimal(appelsParClient),
      compare: e.appeles.valeur === 0 ? 'aucun client appelé' : appelsParClient > 1 ? `${fmtNombre(e.appels.valeur - e.appeles.valeur)} rappels compris` : 'un appel par client',
    },
  ]);
  const visibles = e.agents.slice(0, AGENTS_MAX);
  const reste = e.agents.length - visibles.length;
  p.assurer(18 * 3 + 20);
  p.ecrire('Par agent', MARGE, p.y, { taille: 8, gras: true, couleur: GRIS });
  p.y += 12;
  tableau(
    p,
    [
      { titre: 'Agent', largeur: 170 },
      { titre: 'Appels', largeur: 60, align: 'right' },
      { titre: 'Joints', largeur: 60, align: 'right' },
      { titre: 'Coupons', largeur: 60, align: 'right' },
      { titre: 'Ventes', largeur: 60, align: 'right' },
      { titre: 'Chiffre d’affaires', largeur: 105, align: 'right' },
    ],
    visibles.map((a) => [a.nom, fmtNombre(a.appels), fmtNombre(a.joints), fmtNombre(a.coupons), fmtNombre(a.ventes), fmtMontant(a.ca)]),
    reste > 0 ? `et ${compter(reste, 'autre agent', 'autres agents')}` : undefined,
  );
}

function sectionResultat(p: Page, r: IRapport): void {
  const s = r.resultat;
  const hauteurTableau = 18 * (s.par_public.length + 1) + 24;
  bande(p, 'Résultat', 'ventes attribuées au CRM sur la période', COULEUR.RESULTAT, 72 + 12 + hauteurTableau);
  cartes(p, [
    { libelle: 'Ventes attribuées au CRM', valeur: fmtNombre(s.ventes.valeur), compare: s.ventes },
    { libelle: 'Chiffre d’affaires', valeur: fmtMontant(s.ca.valeur), compare: s.ca },
    { libelle: 'Panier moyen', valeur: fmtMontant(s.panier_moyen.valeur), compare: s.panier_moyen },
  ]);
  p.assurer(hauteurTableau);
  p.ecrire('Par public', MARGE, p.y, { taille: 8, gras: true, couleur: GRIS });
  p.y += 12;
  const totalVentes = s.par_public.reduce((a, l) => a + l.ventes, 0);
  tableau(
    p,
    [
      { titre: 'Public', largeur: 200 },
      { titre: 'Ventes', largeur: 80, align: 'right' },
      { titre: 'Part', largeur: 80, align: 'right' },
      { titre: 'Chiffre d’affaires', largeur: 120, align: 'right' },
    ],
    s.par_public.map((l) => [
      l.libelle,
      fmtNombre(l.ventes),
      totalVentes > 0 ? fmtPct(Math.round((l.ventes / totalVentes) * 1000) / 10) : fmtPct(0),
      fmtMontant(l.ca),
    ]),
  );
}

function sectionRaisons(p: Page, r: IRapport): void {
  bande(p, 'Pourquoi ils ne commandent pas', 'dernier refus de chaque client, sur la période', GRIS);
  tableau(
    p,
    [
      { titre: 'Raison', largeur: 300 },
      { titre: 'Clients', largeur: 80, align: 'right' },
      { titre: 'Part', largeur: 80, align: 'right' },
    ],
    r.raisons.map((x) => [x.raison, fmtNombre(x.nombre), fmtPct(x.part)]),
  );
}

// ---------------------------------------------------------------------------
// Entrée
// ---------------------------------------------------------------------------

/** Dessine le rapport en PDF (A4 portrait) et rend le fichier. */
export function dessinerRapport(r: IRapport, options: Options = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGE, left: MARGE, right: MARGE, bottom: PIED },
      bufferPages: true,
      info: { Title: `Où en sommes-nous, du ${fmtDate(r.periode.debut)} au ${fmtDate(r.periode.fin)}`, Author: 'Chicken Nation' },
    });
    const morceaux: Buffer[] = [];
    doc.on('data', (m: Buffer) => morceaux.push(m));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);

    try {
      const p = new Page(doc, options);
      enTete(p, r);
      aRetenir(p, r.a_retenir);
      sectionInscriptions(p, r);
      sectionCaptes(p, r);
      sectionInactifs(p, r);
      sectionEquipe(p, r);
      sectionResultat(p, r);
      sectionRaisons(p, r);
      pieds(p);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
