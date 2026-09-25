/**
 * AVIS PUBLICS : ce qu'une route sans jeton peut montrer d'un avis client.
 *
 * Le site vitrine n'affiche que la note, le texte et « Prénom N. » sous un
 * avatar à initiales (jamais de photo). Tout le reste (identifiant du client,
 * nom complet, photo, identifiant et référence de commande) ne sert à aucun
 * écran public et facilitait le rapprochement entre un avis et une personne.
 * Le téléphone et l'e-mail ne sortent jamais ici.
 */

import { Prisma } from '@prisma/client';

/** Plafond de `limit` sur les routes publiques d'avis. */
export const AVIS_PUBLICS_LIMITE_MAX = 50;

/**
 * Colonnes lues en base pour un avis public : rien de plus que ce que
 * `versAvisPublic` garde, pour que la requête elle-même ne charge ni le
 * téléphone, ni l'e-mail, ni la commande.
 */
export const AVIS_PUBLIC_SELECT = {
  id: true,
  message: true,
  rating: true,
  created_at: true,
  customer: { select: { first_name: true, last_name: true } },
} as const satisfies Prisma.CommentSelect;

export interface AvisPublic {
  id: string;
  message: string;
  rating: number;
  created_at: Date;
  customer: {
    first_name: string | null;
    /** Initiale du nom seulement (« K » pour « Koné »), jamais le nom entier. */
    last_name: string | null;
  };
}

/** Avis tel que lu en base, avec au plus le prénom et le nom du client. */
export interface AvisLu {
  id: string;
  message: string;
  rating: number;
  created_at: Date;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
}

/** « Koné » → « K » ; nom absent ou vide → null. */
export function initialeDuNom(nom?: string | null): string | null {
  const initiale = (nom ?? '').trim().charAt(0).toUpperCase();
  return initiale || null;
}

/**
 * Liste blanche d'un avis public. On construit un objet neuf plutôt que de
 * retirer des champs : une colonne ajoutée plus tard au `select` ne peut donc
 * pas sortir par mégarde.
 */
export function versAvisPublic(avis: AvisLu): AvisPublic {
  const prenom = (avis.customer?.first_name ?? '').trim();
  return {
    id: avis.id,
    message: avis.message,
    rating: avis.rating,
    created_at: avis.created_at,
    customer: {
      first_name: prenom || null,
      last_name: initialeDuNom(avis.customer?.last_name),
    },
  };
}

/** `limit` demandé, borné entre 1 et le plafond public (10 par défaut). */
export function limiteAvisPublics(limit?: number): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(n, AVIS_PUBLICS_LIMITE_MAX);
}
