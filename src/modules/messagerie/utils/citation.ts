import { CORPS_MESSAGE_SUPPRIME } from 'src/common/constantes/message-supprime';
import type { ResponseMessageDto } from '../dto/response-message.dto';

/**
 * RÉPONDRE À UN MESSAGE PRÉCIS : ce que l'on montre du message cité.
 *
 * L'extrait est TOUJOURS calculé à la lecture, jamais recopié à l'écriture :
 * un original supprimé cesse ainsi d'être montré dans toutes les réponses qui
 * le citent, sans avoir à les retoucher une par une.
 */

/** Qui lit : un employé, ou le client de la conversation. */
export type Lecteur = 'user' | 'customer';

/** Nature de l'original, pour l'icône et le libellé de repli. */
export type TypeCitation = 'text' | 'image' | 'audio' | 'alert';

/** Auteur de l'original, déjà mis en mots pour l'écran. */
export interface AuteurCitation {
  kind: 'user' | 'customer' | 'system' | 'broadcast';
  id: string | null;
  name: string;
}

/** Forme servie dans `replyTo`. */
export interface CitationMessage {
  id: string;
  deleted: boolean;
  kind: TypeCitation;
  excerpt: string;
  author: AuteurCitation;
  createdAt: Date;
}

/** Mention servie dans `mentions`. */
export interface MentionMessage {
  userId: string;
  label: string;
}

/** Longueur maximale de l'extrait, points de suspension compris. */
export const LONGUEUR_EXTRAIT_CITATION = 160;

/** Nom montré au client pour tout message du personnel. */
export const NOM_MAISON = 'Chicken Nation';
/** Nom montré pour un message d'alerte, qui n'a pas d'auteur. */
export const NOM_SYSTEME = 'Système';

/** Corps de repli posés par le serveur quand seule une pièce jointe part. */
const CORPS_REPLI_IMAGE = 'Photo';
const CORPS_REPLI_AUDIO = 'Message vocal';

/**
 * Ce qu'il faut lire de l'original, et rien de plus : ni courriel, ni image
 * de profil, ni rôle. À poser tel quel dans les `include` de lecture.
 */
export const SELECT_CITATION = {
  select: {
    id: true,
    body: true,
    meta: true,
    deletedAt: true,
    createdAt: true,
    broadcastId: true,
    authorUser: { select: { id: true, fullname: true } },
    authorCustomer: { select: { id: true, first_name: true, last_name: true } },
  },
} as const;

/** Les mentions d'un message, pour les `include` de lecture. */
export const SELECT_MENTIONS = {
  select: { userId: true, libelle: true },
} as const;

/** L'original tel que le renvoie `SELECT_CITATION`. */
export interface CitationBrute {
  id: string;
  body: string | null;
  meta?: unknown;
  deletedAt?: Date | null;
  createdAt: Date;
  broadcastId?: string | null;
  authorUser?: { id: string; fullname: string | null } | null;
  authorCustomer?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
  } | null;
}

/** Réduit les blancs (retours à la ligne compris) à une espace simple. */
export function reduireBlancs(texte: string | null | undefined): string {
  return (texte ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Garde les `n` premières unités d'un texte SANS séparer un emoji en deux.
 *
 * ⚠️ Un emoji (« 👍 ») occupe deux unités en JavaScript. Le trancher entre les
 * deux laisse une moitié orpheline : l'écran affiche un losange, et le moteur
 * de Prisma refuse la chaîne (JSON invalide), ce qui ferait échouer en silence
 * l'écriture d'une notification. On recule donc d'une unité dans ce cas.
 */
export function couperSansCasser(texte: string, n: number): string {
  if (texte.length <= n) return texte;
  if (n <= 0) return '';
  const derniere = texte.charCodeAt(n - 1);
  const moitieOrpheline = derniere >= 0xd800 && derniere <= 0xdbff;
  return texte.slice(0, moitieOrpheline ? n - 1 : n);
}

/**
 * Coupe un texte à `max` caractères au plus, points de suspension compris, en
 * évitant de trancher un mot quand c'est possible, et jamais un emoji.
 */
export function couperAuMot(texte: string, max: number): string {
  if (texte.length <= max) return texte;
  const tranche = couperSansCasser(texte, max - 1);
  const dernierBlanc = tranche.lastIndexOf(' ');
  // Coupe au mot seulement si l'on ne perd pas l'essentiel : un très long mot
  // (lien, numéro) est tranché plutôt que réduit à presque rien.
  const coupe = dernierBlanc >= Math.floor(max / 2) ? tranche.slice(0, dernierBlanc) : tranche;
  return `${coupe.trimEnd()}…`;
}

function metaObjet(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

function auteurCitation(m: CitationBrute, lecteur: Lecteur): AuteurCitation {
  if (m.authorUser) {
    // Le client ne voit jamais le nom d'un agent : c'est « la maison » qui
    // répond, comme dans l'application.
    return lecteur === 'customer'
      ? { kind: 'user', id: null, name: NOM_MAISON }
      : { kind: 'user', id: m.authorUser.id, name: reduireBlancs(m.authorUser.fullname) || NOM_MAISON };
  }
  if (m.authorCustomer) {
    const nom = reduireBlancs(
      `${m.authorCustomer.first_name ?? ''} ${m.authorCustomer.last_name ?? ''}`,
    );
    return { kind: 'customer', id: m.authorCustomer.id, name: nom || 'Client' };
  }
  if (m.broadcastId) {
    return { kind: 'broadcast', id: null, name: NOM_MAISON };
  }
  return { kind: 'system', id: null, name: NOM_SYSTEME };
}

/**
 * Résumé du message cité, tel qu'il est servi dans `replyTo`.
 *
 * - Original supprimé : le texte de remplacement, type `text`, aucune méta.
 * - Alerte : sa première ligne.
 * - Photo ou note vocale : extrait vide si le corps n'est que le mot de repli.
 * - Lecteur client : un agent devient « Chicken Nation ».
 */
export function resumerCitation(
  m: CitationBrute | null | undefined,
  lecteur: Lecteur = 'user',
): CitationMessage | null {
  if (!m) return null;

  const auteur = auteurCitation(m, lecteur);

  if (m.deletedAt) {
    return {
      id: m.id,
      deleted: true,
      kind: 'text',
      excerpt: CORPS_MESSAGE_SUPPRIME,
      author: auteur,
      createdAt: m.createdAt,
    };
  }

  const meta = metaObjet(m.meta);
  const corps = m.body ?? '';
  let kind: TypeCitation = 'text';
  let texte = corps;

  if (meta.type === 'ALERTE') {
    kind = 'alert';
    texte = corps.split(/\r?\n/).find((ligne) => ligne.trim() !== '') ?? '';
  } else if (meta.audioUrl) {
    kind = 'audio';
    if (reduireBlancs(corps) === CORPS_REPLI_AUDIO) texte = '';
  } else if (meta.imageUrl) {
    kind = 'image';
    if (reduireBlancs(corps) === CORPS_REPLI_IMAGE) texte = '';
  }

  return {
    id: m.id,
    deleted: false,
    kind,
    excerpt: couperAuMot(reduireBlancs(texte), LONGUEUR_EXTRAIT_CITATION),
    author: auteur,
    createdAt: m.createdAt,
  };
}

/**
 * Version d'un message destinée au CLIENT de la conversation.
 *
 * Le personnel et le client reçoivent le même message, mais pas les mêmes
 * détails : l'auteur cité, s'il est un agent, devient « Chicken Nation », et
 * les mentions, affaire interne, disparaissent. Sert pour le socket, où la
 * charge est calculée une fois pour le personnel.
 */
export function versionClient<T extends Pick<ResponseMessageDto, 'replyTo' | 'mentions'>>(
  message: T,
): Omit<T, 'replyTo' | 'mentions'> & {
  replyTo: CitationMessage | null;
  mentions: MentionMessage[];
} {
  const citation = message.replyTo;
  return {
    ...message,
    replyTo:
      citation && citation.author.kind === 'user'
        ? { ...citation, author: { kind: 'user', id: null, name: NOM_MAISON } }
        : (citation ?? null),
    mentions: [],
  };
}
