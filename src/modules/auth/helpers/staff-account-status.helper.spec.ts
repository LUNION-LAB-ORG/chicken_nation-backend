import { EntityStatus } from '@prisma/client';
import {
  MESSAGE_COMPTE_DESACTIVE,
  motifRefusCompte,
  statutApresConnexion,
} from './staff-account-status.helper';

describe('motifRefusCompte', () => {
  it('laisse passer un compte neuf (NEW) et un compte actif', () => {
    expect(motifRefusCompte(EntityStatus.NEW)).toBeNull();
    expect(motifRefusCompte(EntityStatus.ACTIVE)).toBeNull();
  });

  it('refuse un compte suspendu (INACTIVE) ou supprimé (DELETED)', () => {
    expect(motifRefusCompte(EntityStatus.INACTIVE)).toBe(MESSAGE_COMPTE_DESACTIVE);
    expect(motifRefusCompte(EntityStatus.DELETED)).toBe(MESSAGE_COMPTE_DESACTIVE);
  });

  it('refuse un statut absent ou inconnu (liste d’autorisation)', () => {
    expect(motifRefusCompte(undefined)).toBe(MESSAGE_COMPTE_DESACTIVE);
    expect(motifRefusCompte(null)).toBe(MESSAGE_COMPTE_DESACTIVE);
    expect(motifRefusCompte('BLOCKED' as EntityStatus)).toBe(MESSAGE_COMPTE_DESACTIVE);
  });

  it('couvre toute l’énumération : seuls NEW et ACTIVE ouvrent une session', () => {
    const ouverts = Object.values(EntityStatus).filter((s) => motifRefusCompte(s) === null);
    expect(ouverts.sort()).toEqual([EntityStatus.ACTIVE, EntityStatus.NEW].sort());
  });

  it('écrit un message en français sans tiret long', () => {
    expect(MESSAGE_COMPTE_DESACTIVE).toBe('Ce compte est désactivé. Contactez un administrateur.');
    expect(MESSAGE_COMPTE_DESACTIVE).not.toMatch(/[–—]/);
  });
});

describe('statutApresConnexion', () => {
  it('promeut un compte hérité NEW en ACTIVE', () => {
    expect(statutApresConnexion(EntityStatus.NEW)).toBe(EntityStatus.ACTIVE);
  });

  it('ne touche pas un compte déjà actif', () => {
    expect(statutApresConnexion(EntityStatus.ACTIVE)).toBeUndefined();
  });

  it('ne réactive JAMAIS un compte suspendu ou supprimé', () => {
    expect(statutApresConnexion(EntityStatus.INACTIVE)).toBeUndefined();
    expect(statutApresConnexion(EntityStatus.DELETED)).toBeUndefined();
  });

  it('ne fait rien sans statut', () => {
    expect(statutApresConnexion(undefined)).toBeUndefined();
    expect(statutApresConnexion(null)).toBeUndefined();
  });
});
