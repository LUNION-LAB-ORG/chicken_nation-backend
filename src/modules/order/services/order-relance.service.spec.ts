/**
 * Gestes d'agent sur les paniers à relancer : prise, libération, ignorer,
 * rétablir. Le service est RÉEL, la base est en mémoire et évalue les `where`
 * (relance.base-simulee-spec.ts) : c'est elle qui décide, comme PostgreSQL.
 * Retirer une condition d'une écriture conditionnée fait casser le test de la
 * règle qu'elle porte.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaiementStatus, User, UserRole, UserType } from '@prisma/client';
import { OrderRelanceController } from '../controllers/order-relance.controller';
import { A_CONFIRMER_WHERE } from '../helpers/paiement-livraison.rules';
import {
  ADMIN,
  AWA,
  RESTO_A,
  RESTO_B,
  YAO,
  agent,
  commande,
  correspond,
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
    expect(liste.compteurs).toEqual({ a_relancer: 1, pris: 1, pris_par_moi: 0, en_cours: 1, ignorees: 0, a_confirmer: 0 });
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
      // Commande antérieure au canal : `null`, jamais absent.
      channel: null,
      paiement_a_la_livraison: false,
    });
    expect(g.a_confirmer).toBe(false);
    expect(g.signaux.annulee_par_client).toBeNull();
    expect(g.signaux.commande_suivante).toBeNull();
    expect(g.signaux.paiement_partiel).toEqual(
      expect.objectContaining({ recu: 2000, montant: 5050, libelle: expect.stringMatching(/^Paiement partiel : 2.000 F reçus sur 5.050 F$/) }),
    );
    expect(g.crm).toBeNull();
    expect(liste.prochaine_echeance).not.toBeNull();
    expect(Date.parse(liste.maintenant)).not.toBeNaN();
  });
});

describe('OrderRelanceService : canal du panier (02/10)', () => {
  it('le canal suit chaque panier : tête, autres paniers du groupe et liste des ignorées', async () => {
    const site = commande(maintenant(), 9, { customer_id: 'client-w', phone: '0700000088', channel: 'WEB' });
    const appli = commande(maintenant(), 5, { customer_id: 'client-w', phone: '0700000088', channel: 'APP' });
    const ancien = commande(maintenant(), 7);
    const { service, prisma } = monterRelance({ commandes: [site, appli, ancien] });

    const liste = await service.lister(AWA);
    const groupe = liste.groupes.find((g) => [g.tete.id, ...g.autres.map((b) => b.id)].includes(site.id))!;
    const parId = Object.fromEntries([groupe.tete, ...groupe.autres].map((b) => [b.id, b.channel]));
    expect(parId).toEqual({ [site.id]: 'WEB', [appli.id]: 'APP' });
    expect(liste.groupes.find((g) => g.tete.id === ancien.id)!.tete.channel).toBeNull();

    // La base simulée ignore `select` : on vérifie que la vraie lecture des
    // brouillons (celle qui lit aussi la relance) demande bien le canal.
    const lectures = prisma.order.findMany.mock.calls.filter((c: [{ select?: { relance?: unknown } }]) => c[0].select?.relance);
    expect(lectures.length).toBeGreaterThan(0);
    for (const [arg] of lectures) expect(arg.select.channel).toBe(true);

    await service.ignorer(site.id, { raison_code: 'CLIENT_INJOIGNABLE' }, AWA);
    const { items } = await service.listerIgnorees(AWA);
    expect(Object.fromEntries(items.map((i) => [i.id, i.channel]))).toEqual({ [site.id]: 'WEB', [appli.id]: 'APP' });
    expect(prisma.orderRelance.findMany.mock.calls.at(-1)[0].select.order.select.channel).toBe(true);
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

// ===========================================================================
// Commandes du site à payer à la livraison (19/10)
// ===========================================================================

/** Commande du site à payer à la livraison, que personne n'a encore confirmée. */
const aConfirmer = (minutes: number, surcharge: Record<string, unknown> = {}) =>
  commande(maintenant(), minutes, { payment_method: 'OFFLINE', channel: 'WEB', ...surcharge });

const NON_IGNORABLE =
  "Une commande à payer à la livraison ne s'ignore pas : transmettez-la au restaurant avec " +
  '« Reprendre au téléphone », ou annulez-la.';

describe('OrderRelanceService : commandes du site à payer à la livraison (19/10)', () => {
  it('listée tout de suite, à relancer, devant un panier plus ancien, avec ses champs', async () => {
    const panier = commande(maintenant(), 20);
    const c = aConfirmer(0.1);
    const { service } = monterRelance({ commandes: [panier, c] });

    const liste = await service.lister(AWA);

    expect(liste.groupes.map((g) => [g.cle, g.etat, g.a_confirmer])).toEqual([
      [c.id, 'A_RELANCER', true],
      [panier.id, 'A_RELANCER', false],
    ]);
    expect(liste.groupes[0].tete).toEqual(
      expect.objectContaining({ id: c.id, channel: 'WEB', paiement_a_la_livraison: true, annulee_par_client: false }),
    );
    expect(liste.groupes[0].signaux.commande_suivante).toBeNull();
    expect(liste.groupes[1].tete.paiement_a_la_livraison).toBe(false);
    expect(liste.compteurs).toEqual({ a_relancer: 2, pris: 0, pris_par_moi: 0, en_cours: 0, ignorees: 0, a_confirmer: 1 });
    // Rien n'attend un délai : aucune échéance à surveiller.
    expect(liste.prochaine_echeance).toBeNull();
  });

  it('plus de 3 h : toujours listée, et « Je m’en occupe » accepté ; la lecture du geste demande le canal', async () => {
    const c = aConfirmer(5 * 60);
    const { service, relances, prisma } = monterRelance({ commandes: [c] });

    expect((await service.lister(AWA)).groupes.map((g) => g.cle)).toEqual([c.id]);
    const { groupe } = await service.prendre(c.id, AWA);

    expect(groupe).toEqual(expect.objectContaining({ cle: c.id, etat: 'PRIS', a_confirmer: true }));
    expect(relances.map((r) => r.pris_par_id)).toEqual([AWA.id]);
    // La base simulée rend seulement les champs demandés : sans le canal, le
    // geste ne reconnaîtrait pas la commande et répondrait 409.
    expect(prisma.order.findUnique.mock.calls[0][0].select.channel).toBe(true);
  });

  it('« Je m’en occupe » dès la création : jamais « le client est peut-être en train de payer »', async () => {
    const c = aConfirmer(0.1);
    const { service } = monterRelance({ commandes: [c] });
    await expect(service.prendre(c.id, AWA)).resolves.toEqual({ groupe: expect.objectContaining({ etat: 'PRIS' }) });
  });

  /** Recette R15 du 20/10 : refusé avec « Le client est peut-être en train de payer : attendez 3 min. » */
  it('annulée par le client juste après sa création : « Je m’en occupe » accepté tout de suite', async () => {
    const annulee = aConfirmer(0.5, {
      status: OrderStatus.CANCELLED,
      entity_status: 'DELETED',
      cancelled_by: 'client',
      cancelled_at: plusTot(0.2),
    });
    const { service } = monterRelance({ commandes: [annulee] });

    const [groupe] = (await service.lister(AWA)).groupes;
    expect(groupe).toEqual(expect.objectContaining({ cle: annulee.id, etat: 'A_RELANCER', a_confirmer: false }));
    await expect(service.prendre(annulee.id, AWA)).resolves.toEqual({
      groupe: expect.objectContaining({ cle: annulee.id, etat: 'PRIS' }),
    });
  });

  /**
   * Recette du 20/10 : « A déjà payé ORD-… » sur une commande confirmée, à
   * payer au livreur. La lecture des commandes effectives demande `paied`.
   */
  it('commande récente du même client : payée ou non, renvoyé tel quel', async () => {
    const client = { customer_id: 'client-r', phone: '0700000077' };
    const confirmee = commande(maintenant(), 20, {
      ...client,
      reference: 'ORD-261020-CONFIRMEE',
      auto: false,
      status: OrderStatus.ACCEPTED,
      payment_method: 'OFFLINE',
      channel: 'WEB',
    });
    const c = aConfirmer(5, client);
    const { service } = monterRelance({ commandes: [confirmee, c] });

    const [groupe] = (await service.lister(AWA)).groupes;
    expect(groupe.cle).toBe(c.id);
    expect(groupe.signaux.commande_recente).toEqual({
      reference: 'ORD-261020-CONFIRMEE',
      created_at: confirmee.created_at.toISOString(),
      payee: false,
    });

    const payee = commande(maintenant(), 20, { ...client, reference: 'ORD-261020-PAYEE', paied: true, status: OrderStatus.ACCEPTED });
    const panier = commande(maintenant(), 5, client);
    const relu = monterRelance({ commandes: [payee, panier] });
    expect((await relu.service.lister(AWA)).groupes[0].signaux.commande_recente).toEqual({
      reference: 'ORD-261020-PAYEE',
      created_at: payee.created_at.toISOString(),
      payee: true,
    });
  });

  it('compteur : à relancer ou prise, par moi ou par un collègue ; jamais une commande annulée par le client', async () => {
    const priseYao = aConfirmer(5);
    const priseAwa = aConfirmer(6);
    const annulee = aConfirmer(9, {
      status: OrderStatus.CANCELLED,
      entity_status: 'DELETED',
      cancelled_by: 'client',
      cancelled_at: plusTot(1),
    });
    const { service } = monterRelance({
      commandes: [priseYao, priseAwa, annulee],
      relances: [
        { id: 'r1', order_id: priseYao.id, alerte_le: plusTot(4), pris_par_id: YAO.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null },
        { id: 'r2', order_id: priseAwa.id, alerte_le: plusTot(5), pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null },
      ],
    });

    const liste = await service.lister(AWA);

    expect(liste.compteurs).toEqual(expect.objectContaining({ a_relancer: 1, pris: 2, pris_par_moi: 1, a_confirmer: 2 }));
    const groupeAnnule = liste.groupes.find((g) => g.cle === annulee.id)!;
    expect(groupeAnnule.a_confirmer).toBe(false);
    // La pastille « À la livraison » reste : c'était une commande à payer au livreur.
    expect(groupeAnnule.tete).toEqual(expect.objectContaining({ annulee_par_client: true, paiement_a_la_livraison: true }));
  });

  it('commande suivante du même client : renvoyée en ISO', async () => {
    const c = aConfirmer(30, { customer_id: 'client-s', phone: '0700000044' });
    const reprise = commande(maintenant(), 10, {
      customer_id: 'client-s',
      phone: '0700000044',
      reference: 'ORD-261019-REPRISE',
      auto: false,
      status: OrderStatus.ACCEPTED,
      payment_method: 'OFFLINE',
      channel: 'WEB',
    });
    const { service } = monterRelance({ commandes: [c, reprise] });

    const [groupe] = (await service.lister(AWA)).groupes;

    expect(groupe.cle).toBe(c.id);
    expect(groupe.signaux.commande_suivante).toEqual({
      reference: 'ORD-261019-REPRISE',
      created_at: reprise.created_at.toISOString(),
    });
  });

  it('« Ignorer » : 409, sur la commande comme sur un autre panier de son groupe, même pour un administrateur ; rien écrit', async () => {
    const panier = commande(maintenant(), 20, { customer_id: 'client-l', phone: '0700000066' });
    const c = aConfirmer(2, { customer_id: 'client-l', phone: '0700000066' });
    const { service, relances, journal, appGateway } = monterRelance({ commandes: [panier, c] });

    for (const [id, qui] of [
      [c.id, AWA],
      [panier.id, AWA],
      [c.id, ADMIN],
    ] as [string, User][]) {
      expect(await refus(service.ignorer(id, { raison_code: 'CLIENT_INJOIGNABLE' }, qui))).toEqual({
        classe: ConflictException,
        message: NON_IGNORABLE,
      });
    }
    expect(relances).toEqual([]);
    expect(journal).toEqual([]);
    expect(appGateway.emitToRelances).not.toHaveBeenCalled();
    expect(NON_IGNORABLE).not.toMatch(/[–—]/);
  });

  it('un panier en ligne déjà ignoré du même client n’empêche pas la commande d’être affichée', async () => {
    const panier = commande(maintenant(), 20, { customer_id: 'client-i', phone: '0700000055' });
    const c = aConfirmer(1, { customer_id: 'client-i', phone: '0700000055' });
    const { service } = monterRelance({
      commandes: [panier, c],
      relances: [{ id: 'r1', order_id: panier.id, alerte_le: null, pris_par_id: null, prise_expire_le: null, ignore_le: plusTot(5) }],
    });

    const liste = await service.lister(AWA);

    expect(liste.groupes.map((g) => [g.cle, g.etat, g.a_confirmer])).toEqual([[c.id, 'A_RELANCER', true]]);
    expect(liste.groupes[0].autres).toEqual([]);
  });

  it('non-régression : un panier en ligne seul reste « paiement en cours » 3 min, puis sort après 3 h', async () => {
    const jeune = commande(maintenant(), 1);
    const vieux = commande(maintenant(), 4 * 60);
    const { service } = monterRelance({ commandes: [jeune, vieux] });
    const liste = await service.lister(AWA);
    expect(liste.groupes.map((g) => [g.cle, g.etat, g.a_confirmer])).toEqual([[jeune.id, 'EN_COURS', false]]);
    expect(liste.compteurs.a_confirmer).toBe(0);
  });
});

describe('OrderRelanceService.verifierAnnulable et noterAnnulation (19/10)', () => {
  it('raison connue, précisée si « Autre » ; renvoyée telle qu’elle s’écrit au journal ; rien écrit', async () => {
    const c = aConfirmer(5);
    const { service, relances, journal, appGateway } = monterRelance({ commandes: [c] });

    await expect(service.verifierAnnulable(c.id, { raison_code: 'CLIENT_INJOIGNABLE' }, AWA)).resolves.toBe(
      'Client injoignable',
    );
    await expect(
      service.verifierAnnulable(c.id, { raison_code: 'AUTRE', raison_texte: ' Adresse hors zone ' }, AWA),
    ).resolves.toBe('Autre : Adresse hors zone');
    expect(await refus(service.verifierAnnulable(c.id, { raison_code: 'AUTRE', raison_texte: '  ' }, AWA))).toEqual({
      classe: BadRequestException,
      message: 'Précisez la raison.',
    });
    expect(await refus(service.verifierAnnulable(c.id, { raison_code: 'FLEMME' }, AWA))).toEqual({
      classe: BadRequestException,
      message: 'Choisissez une raison.',
    });
    expect(relances).toEqual([]);
    expect(journal).toEqual([]);
    expect(appGateway.emitToRelances).not.toHaveBeenCalled();
  });

  it('prise par un collègue : 409 pour le centre d’appels ; un administrateur, ou l’agent qui la tient, passe', async () => {
    const c = aConfirmer(5);
    const { service } = monterRelance({
      commandes: [c],
      relances: [{ id: 'r1', order_id: c.id, alerte_le: plusTot(4), pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    });

    expect(await refus(service.verifierAnnulable(c.id, { raison_code: 'DOUBLON' }, YAO))).toEqual({
      classe: ConflictException,
      message: "Agent Awa s'occupe de cette commande : laissez-le conclure.",
    });
    await expect(service.verifierAnnulable(c.id, { raison_code: 'DOUBLON' }, ADMIN)).resolves.toBe('Doublon');
    await expect(service.verifierAnnulable(c.id, { raison_code: 'DOUBLON' }, AWA)).resolves.toBe('Doublon');
  });

  it('plus de 3 h : annulable', async () => {
    const c = aConfirmer(26 * 60);
    const { service } = monterRelance({ commandes: [c] });
    await expect(service.verifierAnnulable(c.id, { raison_code: 'CLIENT_INJOIGNABLE' }, AWA)).resolves.toBe(
      'Client injoignable',
    );
  });

  it('pas une commande à confirmer : 409 qui dit pourquoi', async () => {
    const panier = commande(maintenant(), 20);
    const annuleeParClient = aConfirmer(9, {
      status: OrderStatus.CANCELLED,
      entity_status: 'DELETED',
      cancelled_by: 'client',
      cancelled_at: plusTot(1),
    });
    const reprise = aConfirmer(9, { auto: false, status: OrderStatus.ACCEPTED });
    const annuleeParAgent = aConfirmer(9, { status: OrderStatus.CANCELLED, cancelled_by: AWA.id });
    const especesAppli = commande(maintenant(), 9, { payment_method: 'OFFLINE', channel: 'APP' });
    const { service } = monterRelance({ commandes: [panier, annuleeParClient, reprise, annuleeParAgent, especesAppli] });
    const message = async (id: string) =>
      (await refus(service.verifierAnnulable(id, { raison_code: 'DOUBLON' }, AWA))).message;

    expect(await message(panier.id)).toBe("Seule une commande à payer à la livraison s'annule ici.");
    expect(await message(annuleeParClient.id)).toBe('Le client a déjà annulé cette commande.');
    expect(await message(reprise.id)).toBe("Cette commande n'est plus à relancer : reprise au téléphone.");
    expect(await message(annuleeParAgent.id)).toBe("Cette commande n'est plus à relancer : annulée.");
    expect(await message(especesAppli.id)).toBe("Cette commande n'est plus à relancer.");
  });

  it('rôle non habilité : 403 ; commande d’un autre restaurant : 404 ; inconnue : 404', async () => {
    const ailleurs = aConfirmer(5, { restaurant_id: RESTO_B });
    const local = agent('11111111-0000-4000-8000-000000000009', 'Agent local', {
      type: UserType.RESTAURANT,
      restaurant_id: RESTO_A,
    });
    const { service } = monterRelance({ commandes: [ailleurs], users: [local] });

    const caissier = agent('11111111-0000-4000-8000-0000000000aa', 'Caissier', { role: UserRole.CAISSIER });
    expect((await refus(service.verifierAnnulable(ailleurs.id, { raison_code: 'DOUBLON' }, caissier))).classe).toBe(
      ForbiddenException,
    );
    expect(await refus(service.verifierAnnulable(ailleurs.id, { raison_code: 'DOUBLON' }, local))).toEqual({
      classe: NotFoundException,
      message: 'Commande introuvable.',
    });
    expect(
      await refus(service.verifierAnnulable('99999999-0000-4000-8000-000000000000', { raison_code: 'DOUBLON' }, AWA)),
    ).toEqual({ classe: NotFoundException, message: 'Commande introuvable.' });
  });

  it('noterAnnulation : prise effacée, journal ANNULATION avec l’agent et la raison, agents prévenus', async () => {
    const c = aConfirmer(5);
    const { service, relances, journal, appGateway } = monterRelance({
      commandes: [c],
      relances: [{ id: 'r1', order_id: c.id, alerte_le: plusTot(4), pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    });

    await service.noterAnnulation(c.id, AWA.id, 'Client injoignable');

    expect(relances[0]).toEqual(expect.objectContaining({ pris_par_id: null, pris_le: null, prise_expire_le: null }));
    expect(journal).toEqual([
      expect.objectContaining({ order_id: c.id, action: 'ANNULATION', user_id: AWA.id, raison: 'Client injoignable' }),
    ]);
    expect(appGateway.emitToRelances).toHaveBeenCalledWith(RELANCE_SOCKET_EVENT, {
      motif: 'annulation',
      ids: [c.id],
      nouvelles: [],
      par: AWA.id,
    });
  });

  it('noterAnnulation ne lève jamais : base en panne, les agents sont quand même prévenus', async () => {
    const c = aConfirmer(5);
    const { service, prisma, appGateway } = monterRelance({ commandes: [c] });
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('P1001'));

    await expect(service.noterAnnulation(c.id, AWA.id, 'Doublon')).resolves.toBeUndefined();
    expect(appGateway.emitToRelances).toHaveBeenCalledWith(RELANCE_SOCKET_EVENT, expect.objectContaining({ motif: 'annulation' }));
  });
});

/**
 * `POST /orders/relances/:orderId/annuler` : vrai contrôleur, vrai service de
 * relance sur la base en mémoire. `OrderService.updateStatus` est simulé par
 * une écriture qui ÉVALUE la condition reçue contre la commande, comme la
 * base ; son vrai `where` est vérifié dans `order.service.paiement-livraison.spec.ts`.
 */
describe('POST /orders/relances/:orderId/annuler : déroulé', () => {
  function monterAnnulation(commandes: Record<string, any>[], relances: Record<string, any>[] = []) {
    const monte = monterRelance({ commandes, relances });
    /** Ce qui arrive en base entre le contrôle et l'écriture (un collègue la reprend...). */
    let entreTemps: (() => void) | null = null;
    const orders = {
      updateStatus: jest.fn(
        async (id: string, status: OrderStatus, meta: Record<string, any>, options: { conditionEcriture?: object } = {}) => {
          entreTemps?.();
          const c = monte.commandes.find((x) => x.id === id)!;
          if (options.conditionEcriture && !correspond(c, options.conditionEcriture)) {
            throw new ConflictException('Cette commande vient de changer : actualisez la liste.');
          }
          Object.assign(c, { status, cancelled_by: meta.userId, cancelled_reason: meta.reason, cancelled_at: new Date() });
          return c;
        },
      ),
    };
    const controleur = new OrderRelanceController(monte.service, orders as never);
    const annuler = (id: string, user: User, corps: Record<string, unknown> = { raison_code: 'CLIENT_INJOIGNABLE' }) =>
      controleur.annuler({ user } as never, id, corps as never);
    return { ...monte, orders, annuler, entreTemps: (f: () => void) => (entreTemps = f) };
  }

  it('annule la commande : écriture conditionnée à « à confirmer », journal ANNULATION, sortie de la liste', async () => {
    const c = aConfirmer(5);
    const { annuler, orders, service, journal, appGateway } = monterAnnulation([c]);

    await expect(annuler(c.id, AWA)).resolves.toEqual({ ok: true });

    expect(orders.updateStatus).toHaveBeenCalledTimes(1);
    const [id, status, meta, options] = orders.updateStatus.mock.calls[0];
    expect([id, status, meta]).toEqual([
      c.id,
      OrderStatus.CANCELLED,
      { userId: AWA.id, role: UserRole.CALL_CENTER, reason: 'Client injoignable' },
    ]);
    expect(options?.conditionEcriture).toBe(A_CONFIRMER_WHERE);
    expect(c).toEqual(expect.objectContaining({ status: OrderStatus.CANCELLED, entity_status: 'ACTIVE', cancelled_by: AWA.id }));
    expect(journal.map((j) => [j.action, j.user_id, j.raison])).toEqual([['ANNULATION', AWA.id, 'Client injoignable']]);
    expect(appGateway.emitToRelances).toHaveBeenCalledWith(RELANCE_SOCKET_EVENT, expect.objectContaining({ motif: 'annulation', ids: [c.id] }));
    expect((await service.lister(AWA)).groupes).toEqual([]);
  });

  it('un collègue la reprend au téléphone pendant ce temps : 409, la reprise l’emporte, rien au journal', async () => {
    const c = aConfirmer(5);
    const monte = monterAnnulation([c]);
    monte.entreTemps(() => Object.assign(c, { auto: false, status: OrderStatus.ACCEPTED }));

    expect(await refus(monte.annuler(c.id, AWA))).toEqual({
      classe: ConflictException,
      message: 'Cette commande vient de changer : actualisez la liste.',
    });
    expect(c).toEqual(expect.objectContaining({ auto: false, status: OrderStatus.ACCEPTED }));
    expect(monte.journal).toEqual([]);
    expect(monte.appGateway.emitToRelances).not.toHaveBeenCalled();
  });

  it('refusée avant toute écriture : raison absente, prise d’un collègue, commande qui n’est pas à confirmer', async () => {
    const c = aConfirmer(5);
    const panier = commande(maintenant(), 20);
    const { annuler, orders, journal } = monterAnnulation(
      [c, panier],
      [{ id: 'r1', order_id: c.id, alerte_le: plusTot(4), pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    );

    expect((await refus(annuler(c.id, AWA, {}))).classe).toBe(BadRequestException);
    expect((await refus(annuler(c.id, YAO))).classe).toBe(ConflictException);
    expect((await refus(annuler(panier.id, AWA))).classe).toBe(ConflictException);
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(journal).toEqual([]);
  });

  it('un administrateur annule même pendant la prise d’un collègue', async () => {
    const c = aConfirmer(5);
    const { annuler, journal } = monterAnnulation(
      [c],
      [{ id: 'r1', order_id: c.id, alerte_le: plusTot(4), pris_par_id: AWA.id, pris_le: plusTot(1), prise_expire_le: plusTard(9), ignore_le: null }],
    );
    await expect(annuler(c.id, ADMIN, { raison_code: 'TEST_INTERNE' })).resolves.toEqual({ ok: true });
    expect(journal.map((j) => [j.action, j.user_id, j.raison])).toEqual([['ANNULATION', ADMIN.id, 'Test interne']]);
  });
});
