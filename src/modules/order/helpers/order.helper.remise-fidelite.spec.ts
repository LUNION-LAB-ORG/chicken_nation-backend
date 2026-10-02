/**
 * Remise en points à la création : garde-fou du solde DISPONIBLE (02/10).
 *
 * Les points promis à une commande payée dont le retrait n'est pas encore
 * enregistré ne peuvent pas payer un second panier. La remise vaut alors 0,
 * sans erreur, comme pour un solde insuffisant (l'application ne sait pas
 * afficher autre chose).
 *
 * OrderHelper testé en isolation ; LoyaltyService RÉEL sur la base en mémoire.
 */
import { OrderStatus } from '@prisma/client';
import {
  CLIENT,
  commande,
  monterFidelite,
} from 'src/modules/fidelity/services/loyalty.base-simulee-spec';
import { OrderHelper } from './order.helper';

function monter(commandes: Record<string, unknown>[]) {
  const fidelite = monterFidelite({ solde: 400, commandes });
  const helper = Object.create(OrderHelper.prototype) as OrderHelper;
  Object.assign(helper, { loyaltyService: fidelite.service });
  return { helper, fidelite };
}

const demander = (helper: OrderHelper, points: number, netAmount = 20_000) =>
  helper.remiseFidelite({ customer_id: CLIENT, total_points: 400, points, netAmount });

describe('OrderHelper.remiseFidelite', () => {
  it('aucun point engagé : remise sur le solde', async () => {
    const { helper } = monter([]);

    expect(await demander(helper, 300)).toEqual({ remise: 6000, points: 300 });
  });

  it('points engagés sur une commande payée non déduite : retirés du solde utilisable', async () => {
    // 400 points, dont 150 promis à une commande payée : 250 utilisables.
    const { helper } = monter([commande({ points: 150, status: OrderStatus.ACCEPTED, paied: true })]);

    expect(await demander(helper, 300)).toEqual({ remise: 0, points: 0 });
    expect(await demander(helper, 250)).toEqual({ remise: 5000, points: 250 });
  });

  it('un panier non payé n’engage rien', async () => {
    const { helper } = monter([commande({ points: 150, status: OrderStatus.PENDING, paied: false })]);

    expect(await demander(helper, 400)).toEqual({ remise: 8000, points: 400 });
  });

  it('plafond : enregistre les points de la remise accordée', async () => {
    const { helper } = monter([]);

    expect(await demander(helper, 150, 4000)).toEqual({ remise: 2000, points: 100 });
  });

  it('aucun point demandé : aucune lecture', async () => {
    const { helper, fidelite } = monter([]);

    expect(await demander(helper, 0)).toEqual({ remise: 0, points: 0 });
    expect(fidelite.prisma.order.aggregate).not.toHaveBeenCalled();
  });
});
