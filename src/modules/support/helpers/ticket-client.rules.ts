import { TicketStatus } from '@prisma/client';

/**
 * TICKETS DU CLIENT (27/11), règles sans base, testées par jest.
 *
 * Demande du client : « quand je rentre dans une commande et dans support, au
 * lieu de retrouver le ticket déjà ouvert, il me crée un autre ». Une commande
 * n'a donc qu'UNE demande en cours : tant qu'elle n'est ni résolue ni fermée,
 * « Support » la rouvre.
 */

/** En cours : le service client n'a pas fini de traiter la demande. */
export const STATUTS_TICKET_EN_COURS: TicketStatus[] = [TicketStatus.OPEN, TicketStatus.IN_PROGRESS];

export const estTicketEnCours = (statut: TicketStatus | string | null | undefined): boolean =>
  STATUTS_TICKET_EN_COURS.includes(statut as TicketStatus);

export type IssueCreationTicket<T> =
  /** Aucune demande en cours : on crée. */
  | { voie: 'creer' }
  /** Une demande est déjà en cours pour CETTE commande : on la rouvre. */
  | { voie: 'rouvrir'; ticket: T }
  /** Une demande est en cours pour autre chose : une seule à la fois, on la montre. */
  | { voie: 'autre_demande'; ticket: T };

/**
 * Que faire quand un client demande un ticket ? `enCours` : ses demandes en
 * cours, la plus récente d'abord.
 */
export function issueCreationTicket<T extends { orderId: string | null }>(
  enCours: T[],
  orderId: string | null | undefined,
): IssueCreationTicket<T> {
  if (enCours.length === 0) return { voie: 'creer' };
  const memeCommande = orderId ? enCours.find((t) => t.orderId === orderId) : undefined;
  if (memeCommande) return { voie: 'rouvrir', ticket: memeCommande };
  return { voie: 'autre_demande', ticket: enCours[0] };
}

/** Pièce jointe d'un message de ticket, telle qu'elle est servie. */
export interface PieceJointeTicket {
  audioUrl: string | null;
  audioDurationMs: number | null;
}

/**
 * `meta` d'un message de ticket, réduit à ce qui se lit : la note vocale.
 *
 * La colonne a longtemps porté une simple chaîne (« mobile_app », l'origine
 * du message) : elle n'est jamais servie telle quelle.
 */
export function pieceJointeTicket(meta: unknown): PieceJointeTicket | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const brut = meta as Record<string, unknown>;
  const audioUrl = typeof brut.audioUrl === 'string' && brut.audioUrl.trim() ? brut.audioUrl : null;
  if (!audioUrl) return null;
  const duree = Number(brut.audioDurationMs);
  return { audioUrl, audioDurationMs: Number.isFinite(duree) && duree > 0 ? Math.round(duree) : null };
}

/** Corps d'un message sans texte : la note vocale se suffit à elle-même. */
export const CORPS_NOTE_VOCALE = 'Message vocal';

/** Durée d'une note vocale lue dans un formulaire (« 4200 ») ; illisible : `null`. */
export function lireDureeAudio(valeur: unknown): number | null {
  const duree = Number(valeur);
  if (!Number.isFinite(duree) || duree <= 0) return null;
  // Une note vocale de plus d'une heure n'existe pas : valeur aberrante.
  return duree > 3_600_000 ? null : Math.round(duree);
}
