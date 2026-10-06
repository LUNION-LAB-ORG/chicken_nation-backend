import { ProfileType } from '@prisma/client';

/**
 * Le profil déclaratif à enregistrer : un ÉTABLISSEMENT renseigné vaut
 * déclaration d'études.
 *
 * Les formulaires (application et site) ne demandent l'établissement qu'après
 * un « Oui » à « Êtes-vous étudiant ou élève ? », et le site l'efface sur
 * « Non ». Un établissement sans profil est donc une réponse perdue en route,
 * pas un choix.
 *
 * ⚠️ Règle partagée par les DEUX chemins d'écriture, et c'est pour cela
 * qu'elle vit ici : l'adhésion publique écrit `Customer.profile_type` avant de
 * créer la demande, la demande écrit `CardRequest.profile_type`. Dupliquée,
 * elle aurait fini par diverger, et c'est l'application qui lit le premier
 * champ pour débloquer les menus étudiants.
 *
 * Ne force JAMAIS un profil déjà reçu : le client qui se déclare autre chose
 * garde sa réponse.
 */
export function profilDeclare(
  profilRecu: ProfileType | null | undefined,
  etablissement: string | null | undefined,
): ProfileType | undefined {
  if (profilRecu) return profilRecu;
  return etablissement?.trim() ? ProfileType.ETUDIANT : undefined;
}
