/**
 * Segments de notifications : niveaux visés comme l'audience d'un menu (09/11).
 *
 *  - Étudiant : le profil étudiant, quel que soit le niveau ;
 *  - Standard : aussi le client dont le niveau n'a jamais été calculé ;
 *  - plusieurs niveaux cochés : l'un d'eux suffit ;
 *  - les segments déjà enregistrés avec un seul niveau restent lus.
 */
import { DishAudience, LoyaltyLevel, ProfileType } from '@prisma/client';

import {
  clauseClientsDesAudiences,
  customerAudiences,
  lireAudiences,
} from 'src/modules/menu/utils/dish-audience.util';

import { PushCampaignService } from './push-campaign.service';

type Client = {
  id: string;
  loyalty_level: LoyaltyLevel | null;
  profile_type: ProfileType | null;
  entity_status: string;
};

const CLIENTS: Client[] = [
  { id: 'standard', loyalty_level: LoyaltyLevel.STANDARD, profile_type: null, entity_status: 'ACTIVE' },
  { id: 'etudiant-jamais-classe', loyalty_level: null, profile_type: ProfileType.ETUDIANT, entity_status: 'ACTIVE' },
  { id: 'etudiant-vip', loyalty_level: LoyaltyLevel.VIP, profile_type: ProfileType.ETUDIANT, entity_status: 'ACTIVE' },
  { id: 'vvip', loyalty_level: LoyaltyLevel.VVIP, profile_type: null, entity_status: 'ACTIVE' },
  { id: 'vip-supprime', loyalty_level: LoyaltyLevel.VIP, profile_type: null, entity_status: 'DELETED' },
];

/** Évalue un `where` Prisma simple (AND, OR, égalités) sur un client. */
function correspond(client: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([cle, valeur]) => {
    if (cle === 'AND') return (valeur as Record<string, unknown>[]).every((w) => correspond(client, w));
    if (cle === 'OR') return (valeur as Record<string, unknown>[]).some((w) => correspond(client, w));
    return client[cle] === valeur;
  });
}

function monter() {
  let vus: string[] = [];
  const prisma = {
    customer: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        CLIENTS.filter((c) => correspond(c, where)).map((c) => ({ id: c.id })),
      ),
    },
    notificationSetting: {
      count: jest.fn(async ({ where }: { where: { customer_id: { in: string[] } } }) => {
        vus = where.customer_id.in;
        return vus.length;
      }),
    },
  };
  const service = new PushCampaignService(prisma as never, {} as never);
  return {
    service,
    async clients(filters: Record<string, unknown>): Promise<string[]> {
      vus = [];
      await service.previewCustomFilters(filters as never);
      return [...vus].sort();
    },
  };
}

describe('segment : niveaux visés comme dans les menus', () => {
  it('Étudiant : les étudiants, quel que soit leur niveau', async () => {
    expect(await monter().clients({ audiences: ['ETUDIANT'] })).toEqual(['etudiant-jamais-classe', 'etudiant-vip']);
  });

  it('Standard : aussi le client dont le niveau n’a jamais été calculé', async () => {
    expect(await monter().clients({ audiences: ['STANDARD'] })).toEqual(['etudiant-jamais-classe', 'standard']);
  });

  it('plusieurs niveaux : l’un d’eux suffit, jamais un client supprimé', async () => {
    expect(await monter().clients({ audiences: ['VVIP', 'ETUDIANT'] })).toEqual([
      'etudiant-jamais-classe',
      'etudiant-vip',
      'vvip',
    ]);
    expect(await monter().clients({ audiences: ['VIP'] })).toEqual(['etudiant-vip']);
  });

  it('valeur inconnue ignorée ; rien de connu : pas de critère', async () => {
    expect(await monter().clients({ audiences: ['ROI', 'VVIP'] })).toEqual(['vvip']);
    expect(await monter().clients({ audiences: ['ROI'], loyalty_level: 'VVIP' })).toEqual(['vvip']);
  });

  it('ancien segment à un seul niveau : toujours lu, Standard compris', async () => {
    expect(await monter().clients({ loyalty_level: 'STANDARD' })).toEqual(['etudiant-jamais-classe', 'standard']);
    expect(await monter().clients({ loyalty_level: 'VIP' })).toEqual(['etudiant-vip']);
  });

  it('ancien niveau et nouveaux niveaux ensemble : il faut les deux', async () => {
    expect(await monter().clients({ loyalty_level: 'VIP', audiences: ['ETUDIANT'] })).toEqual(['etudiant-vip']);
  });

  it('même verdict que les menus pour chaque client et chaque niveau', () => {
    for (const audience of Object.values(DishAudience)) {
      const clause = clauseClientsDesAudiences([audience])!;
      for (const c of CLIENTS) {
        expect({ audience, client: c.id, vise: correspond(c, clause) }).toEqual({
          audience,
          client: c.id,
          vise: customerAudiences(c).includes(audience),
        });
      }
    }
  });

  it('lecture des niveaux : doublons et valeurs inconnues écartés ; liste vide sans critère', () => {
    expect(lireAudiences(['VIP', 'VIP', 'ROI', 3, null])).toEqual([DishAudience.VIP]);
    expect(lireAudiences('VIP')).toEqual([]);
    expect(clauseClientsDesAudiences([])).toBeNull();
  });
});
