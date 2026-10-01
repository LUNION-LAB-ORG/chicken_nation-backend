/**
 * Gestes d'agent sur les paniers à relancer : prise, libération, ignorer,
 * rétablir. Le service est RÉEL, la base est en mémoire et évalue les `where`
 * (relance.base-simulee-spec.ts) : c'est elle qui décide, comme PostgreSQL.
 * Retirer une condition d'une écriture conditionnée fait casser le test de la
 * règle qu'elle porte.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaiementStatus, UserRole, UserType } from '@prisma/client';
import {
  ADMIN,
  AWA,
  RESTO_A,
  RESTO_B,
  YAO,
  agent,
  commande,
  monterRelance,
} from '../relance/relance.base-simulee-spec';
import { RELANCE_SOCKET_EVENT } from '../relance/relance.events';

const maintenant = () => new Date();
const plusTard = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const plusTot = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Le message d'une promesse rejetée, avec sa classe. */
async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

describe('OrderRelanceService : gestes', () => {
  it('1. deux prises concurrentes du même groupe : une seule réussit, l’autre lève 409 et n’écrit rien', async () => {
    const a = commande(maintenant(), 6, { customer_id: 'client-x', phone: '0700000099' });
    const b = commande(maintenant(), 4, { customer_id: 'client-x', phone: '0700000099' });
    const { service, relances, journal } = monterRelance({ commandes: [a, b] });

    const resultats = await Promise.allSettled([service.prendre(a.id, AWA), service.prendre(b.id, YAO)]);

    const reussies = resultats.filter((r) => r.status === 'fulfilled');
    const echouees = resultats.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(reussies).toHaveLength(1);
    expect(echouees).toHaveLength(1);
    expect(echouees[0].reason).toBeInstanceOf(ConflictException);
    expect(echouees[0].reason.message).toBe('Déjà prise par Agent Awa.');
    // Tout le groupe à Awa, rien de Yao, ni en base ni au journal.
    expect(relances.map((r) => r.pris_par_id)).toEqual([AWA.id, AWA.id]);
    expect(journal.filter((j) => j.action === 'PRISE').map((j) => j.user_id)).toEqual([AWA.id, AWA.id]);
  });

  it('1 bis. la prise renvoie le groupe à jour, pris par moi', async () => {
    const a = commande(maintenant(), 6);
    const { service, appGateway } = monterRelance({ commandes: [a] });

    const { groupe } = await service.prendre(a.id, AWA);

    expect(groupe).toEqual(
      expect.objectContaining({ cle: a.id, etat: 'PRIS', prise: expect.objectContaining({ par_moi: true }) }),
    );
    expect(groupe!.prise!.par).toEqual({ id: AWA.id, fullname: 'Agent Awa' });
    expect(appGateway.emitToRelances).toHaveBeenCalledWith(RELANCE_SOCKET_EVENT, {
      motif: 'prise',
      ids: [a.id],
      nouvelles: [],
      par: AWA.id,
    });
  });

  it('2. prise sur la prise expirée d’un collègue : réussit', async () => {
    const a = commande(maintenant(), 20);
    const { service, relances } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: plusTot(15), pris_par_id: YAO.id, pris_le: plusTot(12), prise_expire_le: plusTot(2), ignore_le: null }],
    });

    await service.prendre(a.id, AWA);

    expect(relances[0].pris_par_id).toBe(AWA.id);
    expect(relances[0].prise_expire_le.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('2 bis. reprendre sa propre prise la prolonge', async () => {
    const a = commande(maintenant(), 20);
    const { service, relances } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: null, pris_par_id: AWA.id, pris_le: plusTot(5), prise_expire_le: plusTard(1), ignore_le: null }],
    });

    await service.prendre(a.id, AWA);

    expect(relances[0].prise_expire_le.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('3. prise d’une commande ignorée refusée (condition ignore_le du where)', async () => {
    const a = commande(maintenant(), 20);
    const { service, relances } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: null, pris_par_id: null, prise_expire_le: null, ignore_le: plusTot(1) }],
    });

    const r = await refus(service.prendre(a.id, AWA));
    expect(r).toEqual({ classe: ConflictException, message: "Cette commande est ignorée : rétablissez-la d'abord." });
    expect(relances[0].pris_par_id).toBeNull();
  });

  it('3 bis. ignorée par un collègue ENTRE la lecture et l’écriture : la base refuse la prise', async () => {
    const a = commande(maintenant(), 20);
    const monte = monterRelance({ commandes: [a] });
    // L'ignorance arrive juste avant la transaction de prise : seule la
    // condition `ignore_le: null` de l'écriture peut encore la voir.
    const transaction = monte.prisma.$transaction;
    monte.prisma.$transaction = jest.fn(async (arg: unknown) => {
      if (typeof arg === 'function' && !monte.relances.length) {
        monte.relances.push({ id: 'r1', order_id: a.id, alerte_le: null, pris_par_id: null, prise_expire_le: null, ignore_le: new Date() });
      }
      return transaction(arg);
    });

    const r = await refus(monte.service.prendre(a.id, AWA));
    expect(r.message).toBe("Cette commande est ignorée : rétablissez-la d'abord.");
    expect(monte.relances[0].pris_par_id).toBeNull();
  });

  it('4. libérer la prise d’un autre : 409 pour le centre d’appels, accepté pour un administrateur', async () => {
    const a = commande(maintenant(), 20);
    const { service, relances, journal } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: null, pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    });

    const r = await refus(service.liberer(a.id, YAO));
    expect(r).toEqual({
      classe: ConflictException,
      message: "Agent Awa s'occupe de cette commande : lui seul peut la libérer.",
    });
    expect(relances[0].pris_par_id).toBe(AWA.id);

    await expect(service.liberer(a.id, ADMIN)).resolves.toEqual({ ok: true });
    expect(relances[0]).toEqual(expect.objectContaining({ pris_par_id: null, pris_le: null, prise_expire_le: null }));
    expect(journal.map((j) => [j.action, j.user_id])).toEqual([['LIBERATION', ADMIN.id]]);
  });

  it('4 bis. libérer sa propre prise', async () => {
    const a = commande(maintenant(), 20);
    const { service, relances } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: null, pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    });
    await service.liberer(a.id, AWA);
    expect(relances[0].pris_par_id).toBeNull();
  });

  it('5. ignorer pendant la prise d’un autre : 409 ; un administrateur le peut, et la prise est effacée', async () => {
    const a = commande(maintenant(), 20);
    const { service, relances, journal } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: null, pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    });

    const r = await refus(service.ignorer(a.id, { raison_code: 'CLIENT_INJOIGNABLE' }, YAO));
    expect(r).toEqual({
      classe: ConflictException,
      message: "Agent Awa s'occupe de cette commande : laissez-le conclure.",
    });
    expect(relances[0].ignore_le).toBeNull();

    await expect(service.ignorer(a.id, { raison_code: 'DOUBLON' }, ADMIN)).resolves.toEqual({ ok: true, nombre: 1 });
    expect(relances[0]).toEqual(
      expect.objectContaining({ ignore_par_id: ADMIN.id, raison_code: 'DOUBLON', pris_par_id: null, prise_expire_le: null }),
    );
    expect(journal.map((j) => [j.action, j.raison])).toEqual([['IGNORE', 'Doublon']]);
  });

  it('5 bis. ignorer vaut pour tout le groupe du client', async () => {
    const f1 = commande(maintenant(), 8, { customer_id: 'client-f', phone: '0700000077' });
    const f2 = commande(maintenant(), 5, { customer_id: 'client-f', phone: '0700000077' });
    const { service, relances } = monterRelance({ commandes: [f1, f2] });

    await expect(service.ignorer(f1.id, { raison_code: 'CLIENT_INJOIGNABLE' }, AWA)).resolves.toEqual({ ok: true, nombre: 2 });
    expect(relances.filter((r) => r.ignore_le).map((r) => r.order_id).sort()).toEqual([f1.id, f2.id].sort());

    const liste = await service.lister(AWA);
    expect(liste.groupes).toEqual([]);
    expect(liste.compteurs.ignorees).toBe(2);
    const { items } = await service.listerIgnorees(AWA);
    expect(items.map((i) => i.raison_libelle)).toEqual(['Client injoignable', 'Client injoignable']);
    expect(items[0].ignore_par).toEqual({ id: AWA.id, fullname: 'Agent Awa' });
    expect(items[0].encore_en_attente).toBe(true);
  });

  it('6. « Autre » sans texte : 400 « Précisez la raison. » ; raison inconnue : 400', async () => {
    const a = commande(maintenant(), 20);
    const { service } = monterRelance({ commandes: [a] });

    expect(await refus(service.ignorer(a.id, { raison_code: 'AUTRE', raison_texte: '   ' }, AWA))).toEqual({
      classe: BadRequestException,
      message: 'Précisez la raison.',
    });
    expect(await refus(service.ignorer(a.id, { raison_code: 'FLEMME' }, AWA))).toEqual({
      classe: BadRequestException,
      message: 'Choisissez une raison.',
    });
    await expect(
      service.ignorer(a.id, { raison_code: 'AUTRE', raison_texte: ' Rappel demandé demain ' }, AWA),
    ).resolves.toEqual({ ok: true, nombre: 1 });
  });

  it('7. rétablir deux fois : idempotent, alerte_le conservé', async () => {
    const a = commande(maintenant(), 20);
    const alerte = plusTot(15);
    const { service, relances, journal, appGateway } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: alerte, pris_par_id: null, prise_expire_le: null, ignore_le: plusTot(5), ignore_par_id: AWA.id, raison_code: 'DOUBLON', raison_texte: null }],
    });

    await expect(service.retablir(a.id, YAO)).resolves.toEqual({ ok: true, hors_fenetre: false, encore_en_attente: true });
    await expect(service.retablir(a.id, YAO)).resolves.toEqual({ ok: true, hors_fenetre: false, encore_en_attente: true });

    expect(relances[0]).toEqual(
      expect.objectContaining({ ignore_le: null, ignore_par_id: null, raison_code: null, alerte_le: alerte }),
    );
    expect(journal.filter((j) => j.action === 'RETABLISSEMENT')).toHaveLength(1);
    expect(appGateway.emitToRelances).toHaveBeenCalledTimes(1);
    expect((await service.lister(AWA)).compteurs.a_relancer).toBe(1);
  });

  it('7 bis. rétablir une commande de plus de 3 h : accepté, signalé hors fenêtre', async () => {
    const a = commande(maintenant(), 4 * 60);
    const { service } = monterRelance({
      commandes: [a],
      relances: [{ id: 'r1', order_id: a.id, alerte_le: null, ignore_le: plusTot(60) }],
    });
    await expect(service.retablir(a.id, AWA)).resolves.toEqual({ ok: true, hors_fenetre: true, encore_en_attente: true });
  });

  it('8. geste sur une commande payée, annulée, reprise ou trop ancienne : 409 avec le motif', async () => {
    const payee = commande(maintenant(), 20, { paied: true, status: OrderStatus.ACCEPTED });
    const annulee = commande(maintenant(), 20, { status: OrderStatus.CANCELLED });
    const reprise = commande(maintenant(), 20, { auto: false, status: OrderStatus.ACCEPTED });
    const ancienne = commande(maintenant(), 4 * 60);
    const { service } = monterRelance({ commandes: [payee, annulee, reprise, ancienne] });

    expect((await refus(service.prendre(payee.id, AWA))).message).toBe(
      "Cette commande n'est plus à relancer : a payé dans l'application.",
    );
    expect((await refus(service.ignorer(annulee.id, { raison_code: 'DOUBLON' }, AWA))).message).toBe(
      "Cette commande n'est plus à relancer : annulée.",
    );
    expect((await refus(service.liberer(reprise.id, AWA))).message).toBe(
      "Cette commande n'est plus à relancer : reprise au téléphone.",
    );
    expect(await refus(service.prendre(ancienne.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande a plus de 3 h : elle n'est plus suivie ici.",
    });
  });

  it('8 bis. exclusions automatiques : paiement couvert, recommande', async () => {
    const couvert = commande(maintenant(), 20, {
      paiements: [{ status: PaiementStatus.SUCCESS, amount: 5050, total: 5050, created_at: plusTot(19) }],
    });
    const recommandee = commande(maintenant(), 20, { customer_id: 'client-r', phone: '0700000088' });
    const nouvelle = commande(maintenant(), 5, {
      customer_id: 'client-r',
      phone: '0700000088',
      reference: 'ORD-261001-42390',
      paied: true,
      status: OrderStatus.ACCEPTED,
    });
    const { service } = monterRelance({ commandes: [couvert, recommandee, nouvelle] });

    expect((await refus(service.prendre(couvert.id, AWA))).message).toBe(
      "Cette commande n'est plus à relancer : paiement reçu, confirmation en cours.",
    );
    expect((await refus(service.prendre(recommandee.id, AWA))).message).toBe(
      "Cette commande n'est plus à relancer : a recommandé (ORD-261001-42390).",
    );
  });

  it('8 ter. « Je m’en occupe » pendant le paiement : refusé, avec le temps à attendre', async () => {
    const a = commande(maintenant(), 1);
    const { service, relances } = monterRelance({ commandes: [a] });

    const r = await refus(service.prendre(a.id, AWA));
    expect(r.classe).toBe(ConflictException);
    expect(r.message).toMatch(/^Le client est peut-être en train de payer : attendez [12] min\.$/);
    expect(relances).toEqual([]);
  });

  it('9. centre d’appels d’un restaurant : la commande d’un autre restaurant est introuvable (404)', async () => {
    const ailleurs = commande(maintenant(), 20, { restaurant_id: RESTO_B });
    const ici = commande(maintenant(), 20, { restaurant_id: RESTO_A });
    const local = agent('11111111-0000-4000-8000-000000000009', 'Agent local', {
      type: UserType.RESTAURANT,
      restaurant_id: RESTO_A,
    });
    const { service } = monterRelance({ commandes: [ailleurs, ici], users: [local] });

    for (const geste of [
      service.prendre(ailleurs.id, local),
      service.liberer(ailleurs.id, local),
      service.ignorer(ailleurs.id, { raison_code: 'DOUBLON' }, local),
      service.retablir(ailleurs.id, local),
    ]) {
      expect(await refus(geste)).toEqual({ classe: NotFoundException, message: 'Commande introuvable.' });
    }
    // Sa liste ne montre que son restaurant, même s'il en demande un autre.
    const liste = await service.lister(local, RESTO_B);
    expect(liste.groupes.map((g) => g.cle)).toEqual([ici.id]);
  });

  it('commande inconnue : 404', async () => {
    const { service } = monterRelance();
    expect(await refus(service.prendre('99999999-0000-4000-8000-000000000000', AWA))).toEqual({
      classe: NotFoundException,
      message: 'Commande introuvable.',
    });
  });

  it('rôle non habilité : 403, même derrière la garde', async () => {
    const a = commande(maintenant(), 20);
    const { service } = monterRelance({ commandes: [a] });
    for (const role of [UserRole.MARKETING, UserRole.COMPTABLE, UserRole.CAISSIER]) {
      const intrus = agent('11111111-0000-4000-8000-0000000000aa', 'Intrus', { role });
      expect(await refus(service.lister(intrus))).toEqual({
        classe: ForbiddenException,
        message: "Accès réservé au centre d'appels et aux administrateurs.",
      });
      expect((await refus(service.prendre(a.id, intrus))).classe).toBe(ForbiddenException);
    }
  });
});

describe('OrderRelanceService : liste', () => {
  it('compteurs, règles et formes renvoyées', async () => {
    const aRelancer = commande(maintenant(), 9, {
      fullname: null,
      customer: { phone: '+2250700000555', first_name: 'Anne Marie', last_name: 'Aka' },
      phone: null,
      paiements: [{ status: PaiementStatus.SUCCESS, amount: 2000, total: 2000, created_at: plusTot(8) }],
    });
    const enCours = commande(maintenant(), 1);
    const prise = commande(maintenant(), 12);
    const { service, settings } = monterRelance({
      commandes: [aRelancer, enCours, prise],
      relances: [{ id: 'r1', order_id: prise.id, alerte_le: plusTot(9), pris_par_id: YAO.id, pris_le: plusTot(2), prise_expire_le: plusTard(8), ignore_le: null }],
    });
    settings['commandes.relance_duree_prise_minutes'] = '15';

    const liste = await service.lister(AWA);

    expect(liste.regles).toEqual({ delai_minutes: 3, fenetre_heures: 3, duree_prise_minutes: 15, rappel_minutes: 5 });
    expect(liste.compteurs).toEqual({ a_relancer: 1, pris: 1, pris_par_moi: 0, en_cours: 1, ignorees: 0 });
    expect(liste.groupes.map((g) => g.etat)).toEqual(['A_RELANCER', 'PRIS', 'EN_COURS']);
    const [g] = liste.groupes;
    expect(g.tete).toEqual({
      id: aRelancer.id,
      reference: aRelancer.reference,
      created_at: aRelancer.created_at.toISOString(),
      client_nom: 'Anne Marie Aka',
      telephone: '+2250700000555',
      restaurant: { id: RESTO_A, name: 'Riviera' },
      type: 'DELIVERY',
      amount: 5050,
      paiement_refuse: false,
      annulee_par_client: false,
    });
    expect(g.signaux.annulee_par_client).toBeNull();
    expect(g.signaux.paiement_partiel).toEqual(
      expect.objectContaining({ recu: 2000, montant: 5050, libelle: expect.stringMatching(/^Paiement partiel : 2.000 F reçus sur 5.050 F$/) }),
    );
    expect(g.crm).toBeNull();
    expect(liste.prochaine_echeance).not.toBeNull();
    expect(Date.parse(liste.maintenant)).not.toBeNaN();
  });
});

describe('OrderRelanceService : paniers annulés par le client (01/10)', () => {
  /** Panier annulé par le client dans l'application, tel que S1 l'écrit. */
  const annule = (minutes: number, surcharge: Record<string, unknown> = {}) =>
    commande(maintenant(), minutes, {
      status: OrderStatus.CANCELLED,
      entity_status: 'DELETED',
      cancelled_by: 'client',
      cancelled_at: plusTot(1),
      ...surcharge,
    });

  it('compté dans « à relancer », ligne et signal « annulée par le client »', async () => {
    const a = annule(9);
    const enAttente = commande(maintenant(), 8);
    const { service, lecturesBrouillons } = monterRelance({ commandes: [a, enAttente] });

    const liste = await service.lister(AWA);

    expect(lecturesBrouillons()).toBe(1);
    expect(liste.compteurs.a_relancer).toBe(2);
    const groupe = liste.groupes.find((g) => g.tete.id === a.id)!;
    expect(groupe.tete.annulee_par_client).toBe(true);
    expect(groupe.signaux.annulee_par_client).toEqual({ le: a.cancelled_at.toISOString() });
    const autre = liste.groupes.find((g) => g.tete.id === enAttente.id)!;
    expect(autre.tete.annulee_par_client).toBe(false);
    expect(autre.signaux.annulee_par_client).toBeNull();
  });

  it('annulé par le PERSONNEL (reste actif) ou supprimé au back office : absent', async () => {
    const parAgent = commande(maintenant(), 9, { status: OrderStatus.CANCELLED, cancelled_by: AWA.id });
    const supprime = commande(maintenant(), 9, { status: OrderStatus.CANCELLED, entity_status: 'DELETED', cancelled_by: AWA.id });
    const { service } = monterRelance({ commandes: [parAgent, supprime] });
    expect((await service.lister(AWA)).groupes).toEqual([]);
  });

  it('prendre, libérer, ignorer, rétablir : chaque geste marche', async () => {
    const a = annule(9);
    const { service, relances, journal } = monterRelance({ commandes: [a] });

    const { groupe } = await service.prendre(a.id, AWA);
    expect(groupe).toEqual(expect.objectContaining({ etat: 'PRIS' }));
    expect(relances[0].pris_par_id).toBe(AWA.id);

    await service.liberer(a.id, AWA);
    expect(relances[0].pris_par_id).toBeNull();

    await service.ignorer(a.id, { raison_code: 'CLIENT_INJOIGNABLE' }, AWA);
    expect(relances[0].ignore_le).toBeInstanceOf(Date);
    const ignorees = await service.listerIgnorees(AWA);
    expect(ignorees.items).toEqual([
      expect.objectContaining({ id: a.id, annulee_par_client: true, encore_en_attente: true }),
    ]);

    const retabli = await service.retablir(a.id, AWA);
    expect(retabli).toEqual({ ok: true, hors_fenetre: false, encore_en_attente: true });
    expect(relances[0].ignore_le).toBeNull();
    expect(journal.map((j) => j.action)).toEqual(['PRISE', 'LIBERATION', 'IGNORE', 'RETABLISSEMENT']);
  });

  it('réactivable tant qu’il est relançable', async () => {
    const a = annule(9);
    const { service } = monterRelance({ commandes: [a] });
    await expect(service.verifierReactivable(a.id, AWA)).resolves.toBeUndefined();
    // Ignoré : la reprise reste possible, comme pour un panier en attente.
    const b = annule(9);
    const ignore = monterRelance({
      commandes: [b],
      relances: [{ id: 'r1', order_id: b.id, alerte_le: null, pris_par_id: null, prise_expire_le: null, ignore_le: plusTot(1) }],
    });
    await expect(ignore.service.verifierReactivable(b.id, AWA)).resolves.toBeUndefined();
  });

  it('plus réactivable : 409 qui dit pourquoi', async () => {
    const recommande = annule(30, { customer_id: 'client-r', phone: '0700000777' });
    const payee = commande(maintenant(), 5, {
      customer_id: 'client-r',
      phone: '0700000777',
      reference: 'ORD-261001-PAYEE',
      paied: true,
      status: OrderStatus.ACCEPTED,
    });
    const couvert = annule(9, { paiements: [{ status: PaiementStatus.SUCCESS, amount: 5050, total: 5050, created_at: plusTot(8) }] });
    const vieux = annule(4 * 60);
    const reprise = annule(9, { auto: false, entity_status: 'ACTIVE', status: OrderStatus.ACCEPTED });
    const { service } = monterRelance({ commandes: [recommande, payee, couvert, vieux, reprise] });

    expect(await refus(service.verifierReactivable(recommande.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'est plus à relancer : a recommandé (ORD-261001-PAYEE).",
    });
    expect(await refus(service.verifierReactivable(couvert.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'est plus à relancer : paiement reçu, confirmation en cours.",
    });
    expect(await refus(service.verifierReactivable(vieux.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande a plus de 3 h : elle n'est plus suivie ici.",
    });
    expect(await refus(service.verifierReactivable(reprise.id, AWA))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'est plus à relancer : reprise au téléphone.",
    });
  });

  it('réservé au centre d’appels et aux administrateurs', async () => {
    const a = annule(9);
    const { service } = monterRelance({ commandes: [a] });
    const gerant = agent('gerant', 'Gérant', { role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: RESTO_A });
    expect((await refus(service.verifierReactivable(a.id, gerant))).classe).toBe(ForbiddenException);
  });

  it('la reprise note au journal d’où vient la réactivation', async () => {
    const a = annule(9);
    const { service, journal } = monterRelance({ commandes: [a] });
    await service.noterReprise(a.id, AWA.id, 'Annulée par le client le 01/10 à 11:58, réactivée');
    expect(journal).toEqual([
      expect.objectContaining({ order_id: a.id, action: 'REPRISE', user_id: AWA.id, raison: 'Annulée par le client le 01/10 à 11:58, réactivée' }),
    ]);
  });
});
