import { BadRequestException } from '@nestjs/common';
import { EntityStatus, UserRole } from '@prisma/client';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { rolePeut } from 'src/modules/auth/utils/role-peut';
import { couperSansCasser, type MentionMessage } from './citation';

/** Nombre maximal de personnes mentionnées dans un même message. */
export const MAX_MENTIONS = 20;

/** Longueur maximale d'un libellé de mention (colonne VARCHAR(160)). */
const LONGUEUR_MAX_LIBELLE = 160;

/**
 * Normalise la liste d'identifiants reçue, quelle que soit sa forme.
 *
 * En JSON, un tableau arrive tel quel. En FormData (message avec photo ou note
 * vocale), un seul identifiant arrive en CHAÎNE et plusieurs en tableau ;
 * certains clients envoient aussi le tableau sérialisé (`"[...]"`). Une chaîne
 * vide vaut « rien ». Ce qui n'est pas reconnu est rendu tel quel, pour que la
 * validation le refuse au lieu de l'ignorer.
 */
export function normaliserListeIds(valeur: unknown): unknown {
  if (valeur === undefined || valeur === null) return undefined;

  if (Array.isArray(valeur)) {
    const liste = valeur
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '' && v !== undefined && v !== null);
    return liste;
  }

  if (typeof valeur === 'string') {
    const texte = valeur.trim();
    if (texte === '') return undefined;
    if (texte.startsWith('[')) {
      try {
        const lu: unknown = JSON.parse(texte);
        return Array.isArray(lu) ? normaliserListeIds(lu) : [texte];
      } catch {
        return [texte];
      }
    }
    return texte
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }

  return [valeur];
}

/** Un membre de la conversation, tel que le lit `resoudreMentions`. */
export interface MembreMentionnable {
  id: string;
  fullname: string | null;
  role: UserRole | string | null;
  entity_status: EntityStatus | string | null;
}

/** Forme comparable d'un texte : accents composés, casse et blancs neutralisés. */
function formeComparable(texte: string): string {
  return texte.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
}

/** Ce membre peut-il être mentionné (compte actif, accès à la messagerie) ? */
export function estMentionnable(membre: Pick<MembreMentionnable, 'role' | 'entity_status'>): boolean {
  return (
    membre.entity_status === EntityStatus.ACTIVE &&
    rolePeut(membre.role, Modules.MESSAGES, Action.READ)
  );
}

/** Lettre (accents compris), marque combinante ou chiffre : un mot continue. */
const CARACTERE_DE_MOT = /[\p{L}\p{M}\p{N}]/u;

function continueUnMot(caractere: string | undefined): boolean {
  return caractere !== undefined && CARACTERE_DE_MOT.test(caractere);
}

/**
 * Filtre PUR des mentions demandées.
 *
 * Ne garde que les membres de la conversation, actifs, ayant accès à la
 * messagerie, autres que l'auteur, et dont le « @Nom » figure réellement dans
 * le texte : pas de mention fantôme sans rien de visible. Les autres sont
 * ignorés sans faire échouer l'envoi (un membre retiré entre-temps ne doit pas
 * bloquer le message). Le libellé est le nom complet ACTUEL, fixé ici.
 *
 * « Figure dans le texte » veut dire un MOT ENTIER :
 *  - « @Awa Konéssa » ou « contact@Awa Koné » ne mentionnent pas Awa Koné ;
 *  - les libellés les plus longs sont cherchés d'abord et chaque passage du
 *    texte ne sert qu'une fois : dans un groupe qui compte « Awa » et
 *    « Awa Koné », écrire « @Awa Koné » ne prévient pas aussi « Awa ».
 */
export function filtrerMentions(params: {
  ids: string[];
  membres: MembreMentionnable[];
  auteurId: string;
  body: string;
}): MentionMessage[] {
  const { ids, membres, auteurId, body } = params;
  const texte = formeComparable(body ?? '');
  const parId = new Map(membres.map((m) => [m.id, m]));
  const vus = new Set<string>();
  const candidats: (MentionMessage & { cle: string; rang: number })[] = [];

  for (const id of ids) {
    if (!id || vus.has(id) || id === auteurId) continue;
    vus.add(id);

    const membre = parId.get(id);
    if (!membre || !estMentionnable(membre)) continue;

    const libelle = couperSansCasser(
      (membre.fullname ?? '').replace(/\s+/g, ' ').trim(),
      LONGUEUR_MAX_LIBELLE,
    ).trim();
    if (!libelle) continue;

    candidats.push({
      userId: membre.id,
      label: libelle,
      cle: formeComparable(`@${libelle}`),
      rang: candidats.length,
    });
  }

  // Passages du texte déjà attribués à une mention plus longue.
  const occupe: boolean[] = new Array<boolean>(texte.length).fill(false);
  const trouves = new Set<string>();
  const parLongueur = [...candidats].sort(
    (a, b) => b.cle.length - a.cle.length || a.rang - b.rang,
  );

  for (const c of parLongueur) {
    let debut = texte.indexOf(c.cle);
    while (debut !== -1) {
      const fin = debut + c.cle.length;
      const libre = !occupe.slice(debut, fin).some(Boolean);
      if (libre && !continueUnMot(texte[debut - 1]) && !continueUnMot(texte[fin])) {
        occupe.fill(true, debut, fin);
        trouves.add(c.userId);
        break;
      }
      debut = texte.indexOf(c.cle, debut + 1);
    }
  }

  // Ordre de la demande, plafonné.
  return candidats
    .filter((c) => trouves.has(c.userId))
    .slice(0, MAX_MENTIONS)
    .map(({ userId, label }) => ({ userId, label }));
}

/** Le strict nécessaire de Prisma pour lire les membres visés. */
export interface LecteurMembres {
  conversationUser: {
    findMany(args: {
      where: { conversationId: string; userId: { in: string[] } };
      select: {
        user: {
          select: { id: true; fullname: true; role: true; entity_status: true };
        };
      };
    }): Promise<{ user: MembreMentionnable }[]>;
  };
}

/**
 * Mentions RETENUES pour un nouveau message.
 *
 * - Aucune demandée : rien, et aucune erreur, quel que soit l'auteur.
 * - Auteur client : refus. Les mentions sont une affaire interne.
 * - Conversation avec un client : refus. Le client lirait « @Nom » et
 *   la personne visée n'en est souvent pas membre.
 * - Sinon, les seuls membres éligibles (voir `filtrerMentions`).
 */
export async function resoudreMentions(
  prisma: LecteurMembres,
  params: {
    conversation: { id: string; customerId?: string | null };
    authType: 'user' | 'customer';
    auteurId: string;
    body: string;
    ids?: string[] | null;
  },
): Promise<MentionMessage[]> {
  const demandes = [...new Set((params.ids ?? []).filter((id) => !!id))];
  if (demandes.length === 0) return [];

  if (params.authType !== 'user') {
    throw new BadRequestException('Les mentions sont réservées au personnel');
  }
  if (params.conversation.customerId) {
    throw new BadRequestException(
      'Les mentions sont réservées aux conversations internes',
    );
  }

  const visees = demandes.filter((id) => id !== params.auteurId).slice(0, MAX_MENTIONS);
  if (visees.length === 0) return [];

  const lignes = await prisma.conversationUser.findMany({
    where: { conversationId: params.conversation.id, userId: { in: visees } },
    select: {
      user: {
        select: { id: true, fullname: true, role: true, entity_status: true },
      },
    },
  });

  return filtrerMentions({
    ids: visees,
    membres: lignes.map((l) => l.user),
    auteurId: params.auteurId,
    body: params.body,
  });
}
