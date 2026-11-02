/**
 * Tableau de bord, vue d'ensemble : le vivier « à reprendre » (02/11).
 *
 * Inscrits et inactifs ouverts, sans agent et dans aucune campagne en cours :
 * ils ne sont dans la file de personne. Leur nombre s'affiche pour que la
 * reconquête ne s'arrête plus sans que personne le voie (problème 8).
 */
import { CrmSegment, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { BRUT_DEVENIR_VIDE, calculerDevenir } from '../crm.rules';
import { CrmAccessService } from './crm-access.service';
import { CrmAnalyticsService } from './crm-analytics.service';
import { CrmPublicsService } from './crm-publics.service';

function monter(aReprendre: number) {
  const requetes: string[] = [];
  const $queryRaw = jest.fn(async (morceaux: TemplateStringsArray, ...valeurs: unknown[]) => {
    const sql = Prisma.sql(morceaux, ...valeurs).sql;
    requetes.push(sql);
    return sql.includes('FROM "CrmContact" p') ? [{ a_reprendre: aReprendre }] : [{ ventes: 0, ca: 0, historique: 0, ca_historique: 0 }];
  });
  const vide = calculerDevenir(BRUT_DEVENIR_VIDE, true);
  const devenir = Object.fromEntries(
    [...Object.values(CrmSegment), 'CAPTES', 'TOTAL'].map((cle) => [cle, vide]),
  );
  const publics = {
    fenetre: jest.fn(async () => 30),
    devenir: jest.fn(async () => devenir),
    fileCommune: jest.fn(async () => new Map()),
  } as unknown as CrmPublicsService;
  const service = new CrmAnalyticsService({ $queryRaw } as unknown as PrismaService, {} as CrmAccessService, publics);
  return { service, requetes };
}

describe('vueEnsemble : population « à reprendre »', () => {
  it('compte inscrits et inactifs ouverts, sans agent, hors campagne en cours ou suspendue', async () => {
    const { service, requetes } = monter(7);
    const vue = await service.vueEnsemble({});
    expect(vue.population.a_reprendre).toBe(7);
    const population = requetes.find((s) => s.includes('AS a_reprendre'))!;
    expect(population).toContain('p.assigned_to_id IS NULL');
    expect(population).toContain(`cv.status IN ('ACTIVE', 'SUSPENDED')`);
  });

  it('sans objet (null) quand les publics choisis n’ont ni inscrits ni inactifs', async () => {
    const { service } = monter(7);
    const vue = await service.vueEnsemble({ segments: ['GLOVO', 'YANGO'] });
    expect(vue.population.a_reprendre).toBeNull();
  });

  it('les publics choisis comptent dès qu’ils contiennent des inscrits ou des inactifs', async () => {
    const { service } = monter(3);
    const vue = await service.vueEnsemble({ segments: ['INACTIF', 'GLOVO'] });
    expect(vue.population.a_reprendre).toBe(3);
  });

  it('sans public choisi, la population ne compte pas l’annuaire (problème 12)', async () => {
    const { service, requetes } = monter(0);
    await service.vueEnsemble({});
    const population = requetes.find((s) => s.includes('AS a_reprendre'))!;
    expect(population).toContain('p.segment IN (?::"CrmSegment",?::"CrmSegment",?::"CrmSegment",?::"CrmSegment")');
  });
});
