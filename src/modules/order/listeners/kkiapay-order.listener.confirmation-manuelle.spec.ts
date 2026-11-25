/**
 * Confirmation manuelle d'un paiement KKiaPay (`confirmPaymentManually`) :
 * route administrateur `POST /orders/:id/confirm-payment`, et « Confirmer le
 * paiement » de la relance (14/11). Méthode RÉELLE ; le chemin du webhook
 * (`processTransactionSuccess`) est simulé, il a ses propres tests.
 */
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { OrderStatus, PaymentMethod } from '@prisma/client';
import { MESSAGE_KKIAPAY_INJOIGNABLE } from '../helpers/confirmation-paiement.rules';
import { KkiapayOrderListenerService } from './kkiapay-order.listener.service';

const COMMANDE = {
  id: 'o-1',
  reference: 'ORD-261114-68962',
  amount: 8780,
  payment_method: PaymentMethod.ONLINE,
  status: OrderStatus.PENDING,
};

function monter(
  options: {
    commande?: Record<string, unknown>;
    enregistrements?: { order_id: string | null; order?: { reference: string | null } | null }[];
  } = {},
) {
  const service = Object.create(KkiapayOrderListenerService.prototype) as KkiapayOrderListenerService;
  const orderService = { findById: jest.fn(async () => ({ ...COMMANDE, ...options.commande })) };
  const paiementsService = { enregistrementsDeLaTransaction: jest.fn(async () => options.enregistrements ?? []) };
  Object.assign(service, { orderService, paiementsService });
  const traiter = jest
    .spyOn(service, 'processTransactionSuccess')
    .mockResolvedValue({ confirmed: true, justPaid: true, enDouble: false, paiement: { id: 'p-1' }, order: null });
  return { service, orderService, paiementsService, traiter };
}

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

describe('confirmPaymentManually', () => {
  it('rejoue le chemin du webhook avec la transaction et la référence de la commande', async () => {
    const { service, traiter, paiementsService } = monter();

    await expect(service.confirmPaymentManually('o-1', 'TX1')).resolves.toEqual({
      confirmed: true,
      order: null,
      paiement: { id: 'p-1' },
      justPaid: true,
      enDouble: false,
    });
    expect(paiementsService.enregistrementsDeLaTransaction).toHaveBeenCalledWith('TX1');
    expect(traiter).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'transaction.success', transactionId: 'TX1', stateData: COMMANDE.reference }),
    );
  });

  it('transaction qui paie déjà une autre commande : 409, avant tout appel à KKiaPay', async () => {
    const { service, traiter } = monter({ enregistrements: [{ order_id: 'o-2', order: { reference: 'ORD-261114-11111' } }] });

    expect(await refus(service.confirmPaymentManually('o-1', 'TX1'))).toEqual({
      classe: ConflictException,
      message: 'Cette transaction KKiaPay paie déjà la commande ORD-261114-11111.',
    });
    expect(traiter).not.toHaveBeenCalled();
  });

  it('transaction enregistrée sans commande : 409, un administrateur doit la rattacher', async () => {
    const { service, traiter } = monter({ enregistrements: [{ order_id: null, order: null }] });

    expect(await refus(service.confirmPaymentManually('o-1', 'TX1'))).toEqual({
      classe: ConflictException,
      message: 'Cette transaction KKiaPay est déjà enregistrée sans commande : voyez avec un administrateur.',
    });
    expect(traiter).not.toHaveBeenCalled();
  });

  it('déjà rattachée à cette commande : la confirmation se rejoue, sans effet de plus', async () => {
    const { service, traiter } = monter({ enregistrements: [{ order_id: 'o-1', order: { reference: COMMANDE.reference } }] });

    await expect(service.confirmPaymentManually('o-1', 'TX1')).resolves.toEqual(expect.objectContaining({ confirmed: true }));
    expect(traiter).toHaveBeenCalledTimes(1);
  });

  it('KKiaPay ne valide pas : 400 avec le motif en clair', async () => {
    const cas: [string, string][] = [
      ['montant non couvert', 'Le montant payé ne couvre pas la commande : elle reste en attente.'],
      ['KKiaPay: statut non SUCCESS', "KKiaPay indique que ce paiement n'a pas abouti : la commande reste en attente."],
      ['transaction introuvable', "KKiaPay ne connaît pas cette transaction sur le compte du restaurant : vérifiez l'identifiant."],
    ];
    for (const [motif, message] of cas) {
      const { service, traiter } = monter();
      traiter.mockResolvedValueOnce({ confirmed: false, reason: motif });
      expect(await refus(service.confirmPaymentManually('o-1', 'TX1'))).toEqual({ classe: BadRequestException, message });
    }
  });

  it('KKiaPay injoignable : 503 avec un message à suivre', async () => {
    const { service, traiter } = monter();
    traiter.mockRejectedValueOnce(new ServiceUnavailableException('KKiaPay injoignable (verify)'));

    expect(await refus(service.confirmPaymentManually('o-1', 'TX1'))).toEqual({
      classe: ServiceUnavailableException,
      message: MESSAGE_KKIAPAY_INJOIGNABLE,
    });
  });

  it('commande qui n’attend plus de paiement en ligne : 400, sans rien lire ni appeler', async () => {
    for (const commande of [{ payment_method: PaymentMethod.OFFLINE }, { status: OrderStatus.ACCEPTED }]) {
      const { service, traiter, paiementsService } = monter({ commande });
      expect((await refus(service.confirmPaymentManually('o-1', 'TX1'))).classe).toBe(BadRequestException);
      expect(paiementsService.enregistrementsDeLaTransaction).not.toHaveBeenCalled();
      expect(traiter).not.toHaveBeenCalled();
    }
  });
});
