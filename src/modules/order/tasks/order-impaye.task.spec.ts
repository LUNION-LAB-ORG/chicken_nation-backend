import { OrderStatus, PaiementStatus } from '@prisma/client';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { OrderImpayeTask } from './order-impaye.task';

type Alerte = { code: CodeAlerte; reference: string; details: string[] };

/**
 * Prisma simulé. `revendiquees` retient les commandes déjà prises, pour rejouer
 * la course entre deux backends : la seconde revendication rend `count: 0`.
 */
function faussePrisma(commandes: Record<string, unknown>[], reglees: Record<string, unknown>[] = []) {
  const revendiquees = new Set<string>();
  return {
    revendiquees,
    order: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.paied === true ? reglees : commandes),
      ),
      updateMany: jest.fn(({ where }: { where: { id: string } }) => {
        if (revendiquees.has(where.id)) return Promise.resolve({ count: 0 });
        revendiquees.add(where.id);
        return Promise.resolve({ count: 1 });
      }),
    },
  } as unknown as PrismaService & { revendiquees: Set<string> };
}

function tache(prisma: PrismaService) {
  const postees: Alerte[] = [];
  const alertes = { signaler: (a: Alerte) => postees.push(a) } as unknown as AlertesService;
  return { tache: new OrderImpayeTask(prisma, alertes), postees };
}

const IMPAYEE = {
  id: 'o1', reference: 'CMD-1', amount: 12000, paied: false,
  restaurant_id: 'r1', paiements: [] as { status: PaiementStatus; amount: number }[],
};

describe('OrderImpayeTask', () => {
  it('alerte une commande terminée depuis longtemps et toujours impayée', async () => {
    const { tache: t, postees } = tache(faussePrisma([IMPAYEE]));
    const r = await t.passage(new Date('2026-10-08T12:00:00Z'));
    expect(r.alertees).toEqual(['CMD-1']);
    expect(postees[0].code).toBe(CodeAlerte.COMMANDE_SANS_PAIEMENT);
    // Le délai figure dans le message : sinon on croit l'alerte instantanée.
    expect(postees[0].details.join(' ')).toContain('Terminée depuis plus de');
  });

  /**
   * Le cœur du correctif : la commande payée entre-temps ne doit RIEN produire.
   * C'est elle qui remplissait le groupe de fausses alertes.
   */
  it('ne dit rien d’une commande payée entre-temps', async () => {
    const { tache: t, postees } = tache(faussePrisma([{ ...IMPAYEE, paied: true }]));
    const r = await t.passage(new Date());
    expect(r.alertees).toEqual([]);
    expect(postees).toEqual([]);
  });

  /** Double backend : deux processus lisent le même état, un seul alerte. */
  it('n’alerte qu’une fois quand deux processus voient la même commande', async () => {
    const prisma = faussePrisma([IMPAYEE]);
    const a = tache(prisma);
    const b = tache(prisma);
    const r1 = await a.tache.passage(new Date());
    const r2 = await b.tache.passage(new Date());
    expect([r1.alertees, r2.alertees]).toEqual([['CMD-1'], []]);
    expect([a.postees.length, b.postees.length]).toEqual([1, 0]);
  });

  it('annonce la régularisation quand le paiement finit par arriver', async () => {
    const prisma = faussePrisma([], [
      { id: 'o1', reference: 'CMD-1', amount: 12000, restaurant_id: 'r1', paied_at: new Date() },
    ]);
    const { tache: t, postees } = tache(prisma);
    const r = await t.passage(new Date());
    expect(r.regularisees).toEqual(['CMD-1']);
    expect(postees[0].code).toBe(CodeAlerte.PAIEMENT_REGULARISE);
  });

  it('ne cherche que des commandes terminées, impayées et jamais signalées', async () => {
    const prisma = faussePrisma([]);
    const { tache: t } = tache(prisma);
    await t.passage(new Date('2026-10-08T12:00:00Z'));
    const where = (prisma.order.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.paied).toBe(false);
    expect(where.alerte_impaye_at).toBeNull();
    expect(where.status.in).toEqual([OrderStatus.COLLECTED, OrderStatus.COMPLETED]);
    // Le délai est bien dans le passé par rapport à l'heure du passage.
    expect(where.OR[0].completed_at.lte.getTime()).toBeLessThan(
      new Date('2026-10-08T12:00:00Z').getTime(),
    );
  });

  it('se tait complètement quand le cron est désactivé', async () => {
    process.env.DISABLE_IMPAYE_CRON = 'true';
    const prisma = faussePrisma([IMPAYEE]);
    const { tache: t, postees } = tache(prisma);
    const r = await t.verifier();
    delete process.env.DISABLE_IMPAYE_CRON;
    expect([r.alertees, r.regularisees, postees.length]).toEqual([[], [], 0]);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
