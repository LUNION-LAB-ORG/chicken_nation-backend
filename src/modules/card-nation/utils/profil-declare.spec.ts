import { ProfileType } from '@prisma/client';
import { profilDeclare } from './profil-declare';

describe('profilDeclare', () => {
  it('déduit ÉTUDIANT d’un établissement renseigné', () => {
    expect(profilDeclare(undefined, 'ACADÉMIE ELITES')).toBe(ProfileType.ETUDIANT);
    expect(profilDeclare(null, 'Université Félix Houphouët-Boigny')).toBe(ProfileType.ETUDIANT);
  });

  it('ne déduit rien sans établissement', () => {
    expect(profilDeclare(undefined, undefined)).toBeUndefined();
    expect(profilDeclare(undefined, null)).toBeUndefined();
    expect(profilDeclare(undefined, '')).toBeUndefined();
    // Un champ laissé avec des espaces n'est pas une réponse.
    expect(profilDeclare(undefined, '   ')).toBeUndefined();
  });

  /**
   * Le test qui compte : la déduction ne doit jamais écraser ce que le client
   * a répondu lui-même.
   */
  it('respecte un profil déjà reçu', () => {
    expect(profilDeclare(ProfileType.PROFESSIONNEL, 'ACADÉMIE ELITES')).toBe(
      ProfileType.PROFESSIONNEL,
    );
    expect(profilDeclare(ProfileType.ETUDIANT, undefined)).toBe(ProfileType.ETUDIANT);
  });
});
