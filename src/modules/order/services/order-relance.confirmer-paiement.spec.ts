/**
 * « Confirmer le paiement » depuis « À relancer » (14/11) : le client a payé,
 * le webhook n'a rien confirmé. Vrai contrôleur, vrai service de relance, base
 * en mémoire (relance.base-simulee-spec.ts). La confirmation KKiaPay est
 * simulée : ses garde-fous ont leurs propres tests
 * (kkiapay-order.listener.confirmation-manuelle.spec.ts).
 *
 * Et les paiements signalés : les transactions réussies que le webhook a
 * apportées sans confirmer la commande, lues dans le journal d'audit.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrderStatus, User, UserRole } from '@prisma/client';
import { ACTEUR_KKIAPAY_ID } from 'src/kkiapay/kkiapay-audit.helper';
import { OrderRelanceController } from '../controllers/order-relance.controller';
import { MESSAGE_TRANSACTION_ILLISIBLE } from '../helpers/confirmation-paiement.rules';
import { ADMIN, AWA, YAO, agent, commande, monterRelance } from '../relance/relance.base-simulee-spec';
import { RELANCE_SOCKET_EVENT } from '../relance/relance.events';

const maintenant = () => new Date();
const plusTard = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const plusTot = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

const priseDe = (orderId: string, userId: string, expire = plusTard(9)) => ({
  id: `r-${orderId}`,
  order_id: orderId,
  alerte_le: plusTot(4),
  pris_par_id: userId,
  pris_le: plusTot(1),
  prise_expire_le: expire,
  ignore_le: null,
});

describe('POST /orders/relances/:orderId/confirmer-paiement : déroulé', () => {
  function monterConfirmation(commandes: Record<string, any>[], relances: Record<string, any>[] = []) {
    const monte = monterRelance({ commandes, relances });
    const kkiapay = {
      // Ce que fait la vraie confirmation quand KKiaPay valide : la commande
      // sort de l'attente, payée.
      confirmPaymentManually: jest.fn(async (id: string) => {
        Object.assign(monte.commandes.find((c) => c.id === id)!, { status: OrderStatus.ACCEPTED, paied: true });
        return { confirmed: true, order: null, paiement: { id: 'p-1' }, justPaid: true, enDouble: false };
      }),
    };
    const controleur = new OrderRelanceController(monte.service, {} as never, kkiapay as never);
    const confirmer = (id: string, user: User, corps: Record<string, unknown> = { transaction_id: 'TX123' }) =>
      controleur.confirmerPaiement({ user } as never, id, corps as never);
    return { ...monte, kkiapay, confirmer };
  }

  it('confirme le panier : KKiaPay interrogé, journal PAIEMENT_CONFIRME, audit, prise effacée, sortie de la liste', async () => {
    const panier = commande(maintenant(), 20);
    const { confirmer, kkiapay, journal, relances, appGateway, audit, service } = monterConfirmation(
      [panier],
      [priseDe(panier.id, AWA.id)],
    );

    await expect(confirmer(panier.id, AWA, { transaction_id: '  TX123  ' })).resolves.toEqual({
      ok: true,
      reference: panier.reference,
      deja_confirmee: false,
      en_double: false,
    });

    expect(kkiapay.confirmPaymentManually).toHaveBeenCalledWith(panier.id, 'TX123');
    expect(journal.map((j) => [j.action, j.user_id, j.raison])).toEqual([
      ['PAIEMENT_CONFIRME', AWA.id, 'Transaction KKiaPay TX123'],
    ]);
    expect(relances[0]).toEqual(expect.objectContaining({ pris_par_id: null, prise_expire_le: null }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: AWA.id,
        action: 'PAIEMENT_CONFIRME',
        entity_id: panier.id,
        restaurant_id: panier.restaurant_id,
        metadata: expect.objectContaining({ reference: panier.reference, transaction: 'TX123', premiere_confirmation: true }),
      }),
    );
    expect(appGateway.emitToRelances).toHaveBeenCalledWith(RELANCE_SOCKET_EVENT, {
      motif: 'paiement',
      ids: [panier.id],
      nouvelles: [],
      par: AWA.id,
    });
    expect((await service.lister(AWA)).groupes).toEqual([]);
  });

  it('un panier ignoré ou hors fenêtre se confirme aussi : l’argent reçu se rattache quel que soit son âge', async () => {
    const ignore = commande(maintenant(), 20);
    const ancien = commande(maintenant(), 60 * 5);
    const { confirmer, kkiapay } = monterConfirmation(
      [ignore, ancien],
      [{ ...priseDe(ignore.id, AWA.id), pris_par_id: null, prise_expire_le: null, ignore_le: plusTot(2) }],
    );

    await expect(confirmer(ignore.id, YAO)).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(confirmer(ancien.id, YAO)).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(kkiapay.confirmPaymentManually).toHaveBeenCalledTimes(2);
  });

  it('refusée avant KKiaPay : identifiant illisible, commande à payer à la livraison, panier annulé, déjà payé, repris', async () => {
    const panier = commande(maintenant(), 20);
    const aConfirmer = commande(maintenant(), 5, { payment_method: 'OFFLINE', channel: 'WEB' });
    const annule = commande(maintenant(), 20, {
      status: OrderStatus.CANCELLED,
      entity_status: 'DELETED',
      cancelled_by: 'client',
      cancelled_at: plusTot(10),
    });
    const paye = commande(maintenant(), 20, { paied: true });
    const repris = commande(maintenant(), 20, { auto: false, status: OrderStatus.ACCEPTED });
    const { confirmer, kkiapay, journal, appGateway, audit } = monterConfirmation([panier, aConfirmer, annule, paye, repris]);

    for (const transaction_id of [undefined, '', 'TX 123', 'x'.repeat(65)]) {
      expect(await refus(confirmer(panier.id, AWA, { transaction_id }))).toEqual({
        classe: BadRequestException,
        message: MESSAGE_TRANSACTION_ILLISIBLE,
      });
    }
    expect(await refus(confirmer(aConfirmer.id, AWA))).toEqual({
      classe: ConflictException,
      message:
        "Une commande à payer à la livraison n'a aucun paiement en ligne à confirmer : transmettez-la avec " +
        '« Reprendre au téléphone ».',
    });
    expect(await refus(confirmer(annule.id, AWA))).toEqual({
      classe: ConflictException,
      message: 'Le client a annulé ce panier : seul un panier en attente de paiement se confirme ici.',
    });
    expect(await refus(confirmer(paye.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'est plus à relancer : a payé dans l'application.",
    });
    expect(await refus(confirmer(repris.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'est plus à relancer : reprise au téléphone.",
    });

    expect(kkiapay.confirmPaymentManually).not.toHaveBeenCalled();
    expect(journal).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(appGateway.emitToRelances).not.toHaveBeenCalled();
  });

  it('prise d’un collègue : 409 pour le centre d’appels, l’administrateur confirme quand même', async () => {
    const panier = commande(maintenant(), 20);
    const { confirmer, kkiapay, journal } = monterConfirmation([panier], [priseDe(panier.id, AWA.id)]);

    expect(await refus(confirmer(panier.id, YAO))).toEqual({
      classe: ConflictException,
      message: "Agent Awa s'occupe de cette commande : laissez-le conclure.",
    });
    expect(kkiapay.confirmPaymentManually).not.toHaveBeenCalled();

    await expect(confirmer(panier.id, ADMIN)).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(journal.map((j) => [j.action, j.user_id])).toEqual([['PAIEMENT_CONFIRME', ADMIN.id]]);
  });

  it('prise d’un collègue expirée : le centre d’appels confirme', async () => {
    const panier = commande(maintenant(), 20);
    const { confirmer } = monterConfirmation([panier], [priseDe(panier.id, AWA.id, plusTot(1))]);

    await expect(confirmer(panier.id, YAO)).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('rôle non habilité : 403, même en appelant le service directement', async () => {
    const panier = commande(maintenant(), 20);
    const { service } = monterRelance({ commandes: [panier] });

    for (const role of [UserRole.CAISSIER, UserRole.MANAGER, UserRole.COMPTABLE, UserRole.CUISINE]) {
      const r = await refus(
        service.verifierPaiementConfirmable(panier.id, { transaction_id: 'TX123' }, agent('u-x', 'X', { role })),
      );
      expect(r.classe).toBe(ForbiddenException);
    }
  });

  it('KKiaPay refuse ou ne répond pas : l’erreur remonte telle quelle, rien au journal, la prise reste', async () => {
    const panier = commande(maintenant(), 20);
    const { confirmer, kkiapay, journal, relances, appGateway, audit } = monterConfirmation(
      [panier],
      [priseDe(panier.id, AWA.id)],
    );
    const refusKkiapay = new BadRequestException('Le montant payé sur KKiaPay ne couvre pas la commande : elle reste en attente.');
    kkiapay.confirmPaymentManually.mockRejectedValueOnce(refusKkiapay);
    kkiapay.confirmPaymentManually.mockRejectedValueOnce(new ServiceUnavailableException('KKiaPay ne répond pas : réessayez dans un instant.'));

    expect(await refus(confirmer(panier.id, AWA))).toEqual({ classe: BadRequestException, message: refusKkiapay.message });
    expect((await refus(confirmer(panier.id, AWA))).classe).toBe(ServiceUnavailableException);

    expect(journal).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(appGateway.emitToRelances).not.toHaveBeenCalled();
    expect(relances[0].pris_par_id).toBe(AWA.id);
  });

  it('déjà confirmée entre-temps par le webhook : réponse « déjà confirmée », geste quand même journalisé', async () => {
    const panier = commande(maintenant(), 20);
    const { confirmer, kkiapay, journal, audit } = monterConfirmation([panier]);
    kkiapay.confirmPaymentManually.mockResolvedValueOnce({
      confirmed: true,
      order: null,
      paiement: { id: 'p-1' },
      justPaid: false,
      enDouble: false,
    });

    await expect(confirmer(panier.id, AWA)).resolves.toEqual(
      expect.objectContaining({ deja_confirmee: true, en_double: false }),
    );
    expect(journal.map((j) => j.action)).toEqual(['PAIEMENT_CONFIRME']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ premiere_confirmation: false }) }),
    );
  });

  it('noterPaiementConfirme ne lève jamais : base et audit en panne, les agents sont quand même prévenus', async () => {
    const panier = commande(maintenant(), 20);
    const { service, prisma, audit, appGateway } = monterRelance({ commandes: [panier] });
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('P1001'));
    audit.record.mockImplementation(() => {
      throw new Error('audit indisponible');
    });

    const cible = { id: panier.id as string, reference: panier.reference as string, restaurant_id: panier.restaurant_id };
    await expect(
      service.noterPaiementConfirme(cible, AWA, 'TX123', { justPaid: true, enDouble: false }),
    ).resolves.toBeUndefined();
    expect(appGateway.emitToRelances).toHaveBeenCalledWith(
      RELANCE_SOCKET_EVENT,
      expect.objectContaining({ motif: 'paiement', ids: [panier.id] }),
    );
  });
});

describe('GET /orders/relances : paiements signalés par le webhook', () => {
  /** Ligne que le webhook écrit au journal d'audit (kkiapay-audit.helper.ts). */
  const ligneWebhook = (
    reference: string,
    surcharge: { status_code?: number; minutes?: number; actor_id?: string } = {},
    metadata: Record<string, unknown> = {},
  ) => ({
    actor_id: surcharge.actor_id ?? ACTEUR_KKIAPAY_ID,
    module: 'paiements',
    status_code: surcharge.status_code ?? 409,
    created_at: plusTot(surcharge.minutes ?? 15),
    entity_id: metadata.transaction ?? 'TX9',
    metadata: {
      transaction: 'TX9',
      evenement: 'transaction.success',
      montant: 5050,
      moyen: 'MOBILE_MONEY',
      reference_commande: reference,
      motif_non_confirmation: 'transaction introuvable',
      ...metadata,
    },
  });

  it('transaction réussie journalisée sans confirmation : signalée sur le groupe du panier', async () => {
    const panier = commande(maintenant(), 20);
    const { service } = monterRelance({ commandes: [panier], journalAudit: [ligneWebhook(panier.reference)] });

    const [groupe] = (await service.lister(AWA)).groupes;

    expect(groupe.signaux.paiement_signale).toEqual({
      order_id: panier.id,
      reference: panier.reference,
      transaction_id: 'TX9',
      montant: 5050,
      moyen: 'MOBILE_MONEY',
      le: expect.any(String),
      motif: 'transaction introuvable',
    });
  });

  it('refus à l’entrée (503) ou traitement en échec (500) : signalés aussi, avec leur motif', async () => {
    const a = commande(maintenant(), 20);
    const b = commande(maintenant(), 20);
    const { service } = monterRelance({
      commandes: [a, b],
      journalAudit: [
        ligneWebhook(a.reference, { status_code: 503 }, { transaction: 'TXA', motif_non_confirmation: undefined, motif_refus: 'file indisponible' }),
        ligneWebhook(b.reference, { status_code: 500 }, { transaction: 'TXB', motif_non_confirmation: undefined, erreur: 'P1001' }),
      ],
    });

    const signales = (await service.lister(AWA)).groupes.map((g) => g.signaux.paiement_signale);
    expect(signales.map((s) => [s?.transaction_id, s?.motif]).sort()).toEqual([
      ['TXA', 'file indisponible'],
      ['TXB', 'P1001'],
    ]);
  });

  it('ignorés : paiement confirmé (200), refusé par KKiaPay (402), échec annoncé, autre acteur, autre commande, ligne antérieure au panier', async () => {
    const panier = commande(maintenant(), 20);
    const { service } = monterRelance({
      commandes: [panier],
      journalAudit: [
        ligneWebhook(panier.reference, { status_code: 200 }),
        ligneWebhook(panier.reference, { status_code: 402 }),
        ligneWebhook(panier.reference, { status_code: 503 }, { evenement: 'transaction.failed' }),
        ligneWebhook(panier.reference, { actor_id: AWA.id }),
        ligneWebhook('ORD-AUTRE-1'),
        ligneWebhook(panier.reference, { minutes: 25 }),
        ligneWebhook(panier.reference, {}, { transaction: 'TX illisible' }),
      ],
    });

    const [groupe] = (await service.lister(AWA)).groupes;
    expect(groupe.signaux.paiement_signale).toBeNull();
  });

  it('la transaction la plus récente d’un panier ; celle d’un autre panier du groupe si la tête n’en a pas', async () => {
    const ancien = commande(maintenant(), 40, { customer_id: 'client-g', phone: '0700000777' });
    const tete = commande(maintenant(), 20, { customer_id: 'client-g', phone: '0700000777' });
    const { service } = monterRelance({
      commandes: [ancien, tete],
      journalAudit: [
        ligneWebhook(ancien.reference, { minutes: 30 }, { transaction: 'TX-VIEUX' }),
        ligneWebhook(ancien.reference, { minutes: 10 }, { transaction: 'TX-RECENT' }),
      ],
    });

    const [groupe] = (await service.lister(AWA)).groupes;
    expect(groupe.tete.id).toBe(tete.id);
    expect(groupe.signaux.paiement_signale).toEqual(
      expect.objectContaining({ order_id: ancien.id, reference: ancien.reference, transaction_id: 'TX-RECENT' }),
    );
  });

  it('la prise renvoie aussi le signal', async () => {
    const panier = commande(maintenant(), 20);
    const { service } = monterRelance({ commandes: [panier], journalAudit: [ligneWebhook(panier.reference)] });

    const { groupe } = await service.prendre(panier.id, AWA);
    expect(groupe?.signaux.paiement_signale?.transaction_id).toBe('TX9');
  });

  it('journal illisible : la liste se lit quand même, sans signal', async () => {
    const panier = commande(maintenant(), 20);
    const { service, prisma } = monterRelance({ commandes: [panier], journalAudit: [ligneWebhook(panier.reference)] });
    prisma.auditLog.findMany.mockRejectedValue(new Error('P1001'));

    const [groupe] = (await service.lister(AWA)).groupes;
    expect(groupe.signaux.paiement_signale).toBeNull();
  });

  it('aucun panier en ligne en attente : le journal n’est pas lu', async () => {
    const aConfirmer = commande(maintenant(), 5, { payment_method: 'OFFLINE', channel: 'WEB' });
    const { service, prisma } = monterRelance({ commandes: [aConfirmer] });

    const { groupes } = await service.lister(AWA);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].signaux.paiement_signale).toBeNull();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
