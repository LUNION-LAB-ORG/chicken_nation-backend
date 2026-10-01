/**
 * Tâche d'alerte des paniers à relancer : une alerte par panier, même avec
 * deux backends sur la même base, jamais pour un panier pris ou ignoré, et de
 * nouveau quand une prise expire sans traitement.
 */
import { AWA, commande, monterRelance } from '../relance/relance.base-simulee-spec';
import { RELANCE_SOCKET_EVENT } from '../relance/relance.events';
import { OrderRelanceTask } from './order-relance.task';

const MAINTENANT = new Date();
const plusTard = (minutes: number) => new Date(MAINTENANT.getTime() + minutes * 60_000);
const plusTot = (minutes: number) => new Date(MAINTENANT.getTime() - minutes * 60_000);

function monterTache(donnees: Parameters<typeof monterRelance>[0]) {
  const monte = monterRelance(donnees);
  const tache = () => new OrderRelanceTask(monte.prisma, monte.service);
  const alertes = () =>
    monte.appGateway.emitToRelances.mock.calls.filter(
      (c: [string, { motif: string }]) => c[0] === RELANCE_SOCKET_EVENT && c[1].motif === 'alerte',
    );
  return { ...monte, tache, alertes };
}

describe('OrderRelanceTask', () => {
  const avant = process.env.DISABLE_RELANCE_CRON;
  afterEach(() => {
    if (avant === undefined) delete process.env.DISABLE_RELANCE_CRON;
    else process.env.DISABLE_RELANCE_CRON = avant;
  });

  it('deux exécutions simultanées (deux backends) : chaque panier n’est alerté qu’une fois', async () => {
    const a = commande(MAINTENANT, 5);
    const b = commande(MAINTENANT, 7);
    const { tache, alertes, journal, relances } = monterTache({ commandes: [a, b] });

    const [premier, second] = await Promise.all([tache().passage(MAINTENANT), tache().passage(MAINTENANT)]);

    expect([...premier, ...second].sort()).toEqual([a.id, b.id].sort());
    const emis = alertes().flatMap((c: [string, { ids: string[]; nouvelles: string[] }]) => c[1].ids);
    expect(emis.sort()).toEqual([a.id, b.id].sort());
    for (const c of alertes()) expect(c[1].nouvelles).toEqual(c[1].ids);
    expect(journal.filter((j) => j.action === 'ALERTE')).toHaveLength(2);
    expect(relances.every((r) => r.alerte_le?.getTime() === MAINTENANT.getTime())).toBe(true);
  });

  it('un second passage n’alerte plus rien, et n’émet rien', async () => {
    const a = commande(MAINTENANT, 5);
    const { tache, alertes, appGateway } = monterTache({ commandes: [a] });

    await tache().passage(MAINTENANT);
    appGateway.emitToRelances.mockClear();
    await expect(tache().passage(new Date(MAINTENANT.getTime() + 30_000))).resolves.toEqual([]);
    expect(alertes()).toHaveLength(0);
  });

  it('panier en cours de paiement, pris ou ignoré : jamais alerté', async () => {
    const enCours = commande(MAINTENANT, 1);
    const pris = commande(MAINTENANT, 9);
    const ignore = commande(MAINTENANT, 9);
    const { tache, alertes, relances } = monterTache({
      commandes: [enCours, pris, ignore],
      relances: [
        { id: 'r1', order_id: pris.id, alerte_le: null, pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null },
        { id: 'r2', order_id: ignore.id, alerte_le: null, pris_par_id: null, prise_expire_le: null, ignore_le: plusTot(1) },
      ],
    });

    await expect(tache().passage(MAINTENANT)).resolves.toEqual([]);
    expect(alertes()).toHaveLength(0);
    expect(relances.every((r) => r.alerte_le === null)).toBe(true);
  });

  it('prise expirée sans traitement : la commande sonne de nouveau, une fois', async () => {
    const a = commande(MAINTENANT, 20);
    const { tache, alertes, relances } = monterTache({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: plusTot(17), pris_par_id: AWA.id, pris_le: plusTot(11), prise_expire_le: plusTot(1), ignore_le: null }],
    });

    await expect(tache().passage(MAINTENANT)).resolves.toEqual([a.id]);
    expect(relances[0].alerte_le).toEqual(MAINTENANT);
    await expect(tache().passage(new Date(MAINTENANT.getTime() + 30_000))).resolves.toEqual([]);
    expect(alertes()).toHaveLength(1);
  });

  it('rétablie après une alerte : ne sonne pas de nouveau', async () => {
    const a = commande(MAINTENANT, 20);
    const { tache, alertes } = monterTache({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: plusTot(15), pris_par_id: null, prise_expire_le: null, ignore_le: null }],
    });
    await expect(tache().passage(MAINTENANT)).resolves.toEqual([]);
    expect(alertes()).toHaveLength(0);
  });

  it('DISABLE_RELANCE_CRON=true : ne fait rien', async () => {
    process.env.DISABLE_RELANCE_CRON = 'true';
    const { tache, prisma, alertes } = monterTache({ commandes: [commande(MAINTENANT, 5)] });

    await expect(tache().alerter()).resolves.toEqual([]);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(alertes()).toHaveLength(0);
  });

  it('une base injoignable ne fait pas tomber la tâche', async () => {
    delete process.env.DISABLE_RELANCE_CRON;
    const { tache, prisma } = monterTache({ commandes: [commande(MAINTENANT, 5)] });
    prisma.order.findMany.mockRejectedValue(new Error('P1001'));

    await expect(tache().alerter()).resolves.toEqual([]);
  });
});
