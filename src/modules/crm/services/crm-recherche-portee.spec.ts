import { UserRole, UserType } from '@prisma/client';
import { estRechercheParNumero } from './crm-contact.query';

describe('estRechercheParNumero', () => {
  /**
   * Ce prédicat décide de la PORTÉE : vrai, l'agent cherche dans tout le
   * fichier ; faux, il reste dans son portefeuille. Une erreur ici ouvre la
   * base entière sur une recherche par nom.
   */
  it('reconnaît un numéro complet, quelle que soit la mise en forme', () => {
    for (const saisie of [
      '0787794012',
      '07 87 79 40 12',
      '+2250787794012',
      '+225 07 87 79 40 12',
      '07.87.79.40.12',
      '07-87-79-40-12',
    ]) {
      expect([saisie, estRechercheParNumero(saisie)]).toEqual([saisie, true]);
    }
  });

  it('refuse un nom, un email, ou un numéro trop court', () => {
    for (const saisie of [
      'Walliat',
      'Walliat Ben',
      'ben@example.com',
      '0787',
      '07 87',
      'CN-BA123',
      '',
      '   ',
      undefined,
    ]) {
      expect([saisie, estRechercheParNumero(saisie)]).toEqual([saisie, false]);
    }
  });

  /** Un nom qui contient des chiffres ne doit pas passer pour un numéro. */
  it('refuse une saisie mêlant lettres et chiffres', () => {
    expect(estRechercheParNumero('zone 4 07878888')).toBe(false);
    expect(estRechercheParNumero('07878888 zone')).toBe(false);
  });
});

describe('porteeRecherche', () => {
  // Le service n'a besoin d'aucune dépendance pour cette méthode.
  const AccessService = jest.requireActual<{
    CrmAccessService: new (...a: never[]) => {
      porteeRecherche: (u: unknown, n: boolean) => Record<string, unknown>;
    };
  }>('./crm-access.service').CrmAccessService;
  const service = new AccessService();

  const agent = {
    id: 'a1',
    role: UserRole.CALL_CENTER,
    type: UserType.BACKOFFICE,
    restaurant_id: null,
  };

  it('par NUMÉRO : l’agent cherche dans tout le fichier', () => {
    expect(service.porteeRecherche(agent, true)).toEqual({});
  });

  /**
   * Le test qui protège le fichier client : par nom, l'agent reste chez lui.
   * Sans ça, taper une lettre listerait et exporterait toute la base.
   */
  it('par NOM : l’agent reste dans son portefeuille', () => {
    const portee = service.porteeRecherche(agent, false);
    expect(JSON.stringify(portee)).toContain('assigned_to_id');
  });

  /** Le cloisonnement par restaurant tient même sur une recherche par numéro. */
  it('un compte de point de vente reste limité à son restaurant', () => {
    const caissier = {
      id: 'c1',
      role: UserRole.CAISSIER,
      type: UserType.RESTAURANT,
      restaurant_id: 'r1',
    };
    expect(JSON.stringify(service.porteeRecherche(caissier, true))).toContain('r1');
  });
});
