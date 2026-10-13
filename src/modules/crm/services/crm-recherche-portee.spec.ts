import { UserRole, UserType } from '@prisma/client';
import { CrmAccessService } from './crm-access.service';

/**
 * L'onglet Contacts est l'ANNUAIRE : tout le monde le parcourt entièrement.
 * Décision de l'utilisateur du 13/10, prise après exposition du risque.
 *
 * Ces tests gardent les deux limites qui n'ont PAS été ouvertes avec, et dont
 * dépend le cloisonnement du fichier client.
 */
describe('porteeListe', () => {
  const service = new CrmAccessService(null as never);

  const AGENTS_SIEGE = [
    { id: 'a1', role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE, restaurant_id: null },
    { id: 'a2', role: UserRole.MARKETING, type: UserType.BACKOFFICE, restaurant_id: null },
    { id: 'a3', role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null },
  ];

  it('ouvre le fichier entier à tout compte du siège', () => {
    for (const user of AGENTS_SIEGE) {
      expect([user.role, service.porteeListe(user as never)]).toEqual([user.role, {}]);
    }
  });

  /**
   * Le cloisonnement par RESTAURANT est une autre règle, et elle tient : un
   * compte de point de vente ne voit que les fiches de son restaurant, quelle
   * que soit l'ouverture accordée aux agents du siège.
   */
  it('laisse un compte de point de vente sur son restaurant', () => {
    const caissier = {
      id: 'c1',
      role: UserRole.CAISSIER,
      type: UserType.RESTAURANT,
      restaurant_id: 'r1',
    };
    expect(JSON.stringify(service.porteeListe(caissier as never))).toContain('r1');
  });

  /**
   * ⚠️ LE TEST QUI COMPTE. `portee` reste restrictive, et c'est elle que doit
   * utiliser toute route par laquelle des données SORTENT. La confondre avec
   * `porteeListe` laisserait un agent exporter le fichier entier.
   */
  it('n’élargit PAS la portée restrictive, qui garde le portefeuille', () => {
    const agent = {
      id: 'a1',
      role: UserRole.CALL_CENTER,
      type: UserType.BACKOFFICE,
      restaurant_id: null,
    };
    const restrictive = JSON.stringify(service.portee(agent as never));
    expect(restrictive).toContain('assigned_to_id');
    expect(restrictive).not.toEqual(JSON.stringify(service.porteeListe(agent as never)));
  });
});
