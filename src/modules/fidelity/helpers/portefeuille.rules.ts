/**
 * « MES CADEAUX » CLASSÉS PAR TYPE (26/11).
 *
 * L'écran de l'appli range le portefeuille en trois onglets : Points, Bons,
 * Cadeaux, avec quelques chiffres en haut de chacun. Le classement et les
 * chiffres sont calculés ICI, sur tout le portefeuille, et non sur la page
 * affichée : l'appli charge la liste vingt lignes à la fois.
 */

export type CategoriePortefeuille = 'POINTS' | 'BONS' | 'CADEAUX';

/** Ce qu'il faut d'une ligne du portefeuille pour la classer et la compter. */
export interface LignePortefeuille {
  kind: string;
  status: string;
  amount: number | null;
  remaining: number | null;
  points: number | null;
}

export interface ResumePortefeuille {
  points: { nombre: number; total: number };
  bons: { nombre: number; disponibles: number; valeur: number; utilises: number };
  cadeaux: { nombre: number; a_gratter: number; disponibles: number; utilises: number };
}

/**
 * Onglet d'une ligne. Une carte pas encore grattée (`MYSTERY`) est un cadeau
 * surprise : elle reste dans « Cadeaux » tant qu'elle n'a pas été grattée, même
 * si elle cache des points.
 */
export function categorieDuPortefeuille(kind: string): CategoriePortefeuille {
  if (kind === 'POINTS') return 'POINTS';
  if (kind === 'VOUCHER' || kind === 'PROMO_CODE') return 'BONS';
  return 'CADEAUX';
}

/** Onglet demandé par l'appli ; tout autre texte (ou rien) : tout le portefeuille. */
export function lireCategoriePortefeuille(valeur: unknown): CategoriePortefeuille | null {
  const texte = typeof valeur === 'string' ? valeur.trim().toUpperCase() : '';
  return texte === 'POINTS' || texte === 'BONS' || texte === 'CADEAUX' ? texte : null;
}

/** Chiffres affichés en haut de chaque onglet. */
export function resumePortefeuille(lignes: LignePortefeuille[]): ResumePortefeuille {
  const resume: ResumePortefeuille = {
    points: { nombre: 0, total: 0 },
    bons: { nombre: 0, disponibles: 0, valeur: 0, utilises: 0 },
    cadeaux: { nombre: 0, a_gratter: 0, disponibles: 0, utilises: 0 },
  };

  for (const ligne of lignes) {
    const categorie = categorieDuPortefeuille(ligne.kind);

    if (categorie === 'POINTS') {
      // Des points annulés ou expirés n'ont pas été gagnés : ils ne comptent pas.
      if (ligne.status === 'EXPIRED') continue;
      resume.points.nombre += 1;
      resume.points.total += Math.max(0, Number(ligne.points) || 0);
      continue;
    }

    if (categorie === 'BONS') {
      resume.bons.nombre += 1;
      if (ligne.status === 'AVAILABLE') {
        resume.bons.disponibles += 1;
        // Un bon entamé vaut ce qu'il lui reste ; un code promo n'a pas de montant.
        resume.bons.valeur += Math.max(0, Number(ligne.remaining ?? ligne.amount) || 0);
      } else if (ligne.status === 'USED') {
        resume.bons.utilises += 1;
      }
      continue;
    }

    resume.cadeaux.nombre += 1;
    if (ligne.status === 'TO_SCRATCH') resume.cadeaux.a_gratter += 1;
    else if (ligne.status === 'AVAILABLE') resume.cadeaux.disponibles += 1;
    else if (ligne.status === 'USED') resume.cadeaux.utilises += 1;
  }

  return resume;
}
