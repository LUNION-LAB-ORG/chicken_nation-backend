import { EntityStatus } from '@prisma/client';

/**
 * Statut d'un compte du personnel face à la connexion et aux jetons.
 *
 * Seuls NEW et ACTIVE ouvrent une session. NEW est un reste du modèle de juin
 * 2025 (un compte naissait NEW et la première connexion le passait ACTIVE) :
 * des comptes anciens peuvent encore le porter, ils restent légitimes. Un
 * statut posé par un administrateur (INACTIVE : suspendu, DELETED : supprimé)
 * ferme la session, et la connexion ne doit plus jamais le défaire.
 *
 * Liste d'autorisation plutôt que d'exclusion : un statut ajouté plus tard à
 * l'énumération est refusé tant qu'on ne l'a pas explicitement ouvert ici.
 */
const STATUTS_AUTORISES: ReadonlySet<EntityStatus> = new Set<EntityStatus>([
  EntityStatus.NEW,
  EntityStatus.ACTIVE,
]);

export const MESSAGE_COMPTE_DESACTIVE =
  'Ce compte est désactivé. Contactez un administrateur.';

/**
 * Motif du refus pour un compte dont le statut interdit toute session, ou
 * `null` si le compte peut se connecter et utiliser ses jetons.
 */
export function motifRefusCompte(
  status: EntityStatus | null | undefined,
): string | null {
  if (status && STATUTS_AUTORISES.has(status)) return null;
  return MESSAGE_COMPTE_DESACTIVE;
}

/**
 * Statut à écrire après une connexion réussie, ou `undefined` s'il ne faut pas
 * y toucher. Seule la promotion NEW vers ACTIVE subsiste : le socket exige
 * ACTIVE, un compte hérité resté NEW n'aurait pas le temps réel sans elle.
 */
export function statutApresConnexion(
  status: EntityStatus | null | undefined,
): EntityStatus | undefined {
  return status === EntityStatus.NEW ? EntityStatus.ACTIVE : undefined;
}
