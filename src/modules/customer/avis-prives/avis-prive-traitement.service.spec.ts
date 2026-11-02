/**
 * Gestes du personnel sur un avis (contrat 3.3 à 3.8), sur une base simulée
 * dont les `updateMany` conditionnés sont de vrais claims.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  AvisCanal,
  AvisResultat,
  AvisRessenti,
  AvisSolution,
  AvisStatut,
  AvisSuiviType,
  Prisma,
  TicketPriority,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import { avisParDefaut, creerBaseAvis } from './avis-prive-base-simulee-spec';
import { AvisPriveTraitementService } from './avis-prive-traitement.service';
import { MESSAGE_CONFLIT, MESSAGE_SANS_ACCORD, MESSAGE_SOLUTION, TEXTE_RAPPROCHEMENT } from './avis-prive.rules';
import { AvisPriveService } from './avis-prive.service';

const MAINTENANT = new Date('2026-11-02T10:00:00.000Z');
const RECU = new Date('2026-11-02T08:42:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'c0000000-0000-4000-8000-000000000001';
const AUTRE_CLIENT = 'c0000000-0000-4000-8000-000000000002';
const COMMANDE = 'd0000000-0000-4000-8000-000000000001';
const COMMANDE_AUTRE = 'd0000000-0000-4000-8000-000000000002';
const CATEGORIE = 'e0000000-0000-4000-8000-000000000001';

const agent = (id: string, fullname: string, role: UserRole = UserRole.CALL_CENTER) =>
  ({ id, fullname, role, type: UserType.BACKOFFICE, restaurant_id: null }) as unknown as User;
const AWA_AGENT = agent('u-cc', 'Gbonhi Max');
const COLLEGUE = agent('u-cc2', 'Kouassi Ama');
const ADMIN = agent('u-admin', 'Administrateur', UserRole.ADMIN);

function monter(champs: Record<string, unknown> = {}, depart: Parameters<typeof creerBaseAvis>[0] = {}) {
  const base = creerBaseAvis({
    avis: [
      {
        id: ID,
        ressenti: AvisRessenti.PAS_CONTENT,
        canal: AvisCanal.TELEPHONE,
        restaurant_id: 'resto-yop',
        restaurant: { id: 'resto-yop', name: 'Yopougon' },
        commentaire: 'Frites froides.',
        telephone: '+2250707000001',
        prenom: 'Awa',
        accord_rappel: true,
        statut: AvisStatut.A_RAPPELER,
        echeance_at: new Date(RECU.getTime() + 86_400_000),
        created_at: RECU,
        ...champs,
      },
    ],
    orders: [
      { id: COMMANDE, reference: 'CN-A1B2', customer_id: CLIENT, entity_status: 'ACTIVE' },
      { id: COMMANDE_AUTRE, reference: 'CN-Z9Y8', customer_id: AUTRE_CLIENT, entity_status: 'ACTIVE' },
    ],
    users: [
      { id: 'u-cc2', fullname: 'Kouassi Ama', role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE, entity_status: 'ACTIVE' },
      { id: 'u-mkt', fullname: 'Marketing', role: UserRole.MARKETING, type: UserType.BACKOFFICE, entity_status: 'ACTIVE' },
    ],
    categories: [{ id: CATEGORIE, name: 'Qualité', entity_status: 'ACTIVE' }],
    ...depart,
  });
  const lecture = new AvisPriveService(base.prisma as never);
  // La fiche rendue après chaque geste : la ligne en base suffit ici.
  jest.spyOn(lecture, 'fiche').mockImplementation(async (id: string) => ({ ...base.avis(id) }) as never);
  const tickets = {
    createTicket: jest.fn(async () => ({ id: 'ticket-1', code: 'QUA-00012' })),
  };
  const service = new AvisPriveTraitementService(base.prisma as never, lecture, tickets as never);
  return { base, service, tickets, lecture };
}

describe('journal (3.3)', () => {
  it('appel Joint : premier contact, En cours, une tentative, avis confié à l’agent', async () => {
    const { base, service } = monter();
    await service.journal(ID, { action: 'APPEL', resultat: AvisResultat.JOINT, note: 'Bon de 2 000 F proposé.' }, AWA_AGENT, MAINTENANT);
    expect(base.avis(ID)).toMatchObject({
      statut: AvisStatut.EN_COURS,
      premier_contact_at: MAINTENANT,
      tentatives_appel: 1,
      agent_id: 'u-cc',
    });
    expect(base.suivis(ID)[0]).toMatchObject({
      type: AvisSuiviType.APPEL,
      resultat: AvisResultat.JOINT,
      note: 'Bon de 2 000 F proposé.',
      statut_avant: AvisStatut.A_RAPPELER,
      statut_apres: AvisStatut.EN_COURS,
      auteur_id: 'u-cc',
      auteur_nom: 'Gbonhi Max',
    });
  });

  it('appel ou WhatsApp refusés sans accord de rappel (rien n’est écrit)', async () => {
    const { base, service } = monter({ accord_rappel: false, statut: AvisStatut.NOUVEAU, echeance_at: null });
    await expect(
      service.journal(ID, { action: 'APPEL', resultat: AvisResultat.JOINT }, AWA_AGENT, MAINTENANT),
    ).rejects.toThrow(MESSAGE_SANS_ACCORD);
    await expect(
      service.journal(ID, { action: 'WHATSAPP', resultat: AvisResultat.JOINT }, AWA_AGENT, MAINTENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(base.suivis(ID)).toHaveLength(0);
    // La note interne reste possible.
    await service.journal(ID, { action: 'NOTE', note: 'Client rappelé par le store.' }, AWA_AGENT, MAINTENANT);
    expect(base.suivis(ID)).toHaveLength(1);
  });

  it('auto-attribution seulement si l’avis n’a pas d’agent : jamais repris à un collègue', async () => {
    const { base, service } = monter({ agent_id: 'u-cc2' });
    await service.journal(ID, { action: 'APPEL', resultat: AvisResultat.INJOIGNABLE }, AWA_AGENT, MAINTENANT);
    expect(base.avis(ID)).toMatchObject({ agent_id: 'u-cc2', statut: AvisStatut.INJOIGNABLE, premier_contact_at: null });
  });

  it('une note interne ne touche pas au statut posé entre-temps par un collègue', async () => {
    const { base, service } = monter();
    const lire = base.prisma.avisPrive.findFirst.getMockImplementation()!;
    base.prisma.avisPrive.findFirst.mockImplementationOnce(async (args) => {
      const lu = await lire(args); // l'agent lit « À rappeler »…
      base.avis(ID).statut = AvisStatut.RESOLU; // …un collègue clôt l'avis pendant ce temps
      return lu;
    });
    await service.journal(ID, { action: 'NOTE', note: 'Rappeler après 18 h.' }, AWA_AGENT, MAINTENANT);
    expect(base.suivis(ID)[0].statut_avant).toBe(AvisStatut.A_RAPPELER);
    expect(base.avis(ID).statut).toBe(AvisStatut.RESOLU);
  });

  it('claim : deux appels lancés sur le même statut lu, un seul aboutit, l’autre 409', async () => {
    const { base, service } = monter();
    const resultats = await Promise.allSettled([
      service.journal(ID, { action: 'APPEL', resultat: AvisResultat.JOINT }, AWA_AGENT, MAINTENANT),
      service.journal(ID, { action: 'APPEL', resultat: AvisResultat.INJOIGNABLE }, COLLEGUE, MAINTENANT),
    ]);
    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refus = resultats.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refus.reason).toBeInstanceOf(ConflictException);
    expect(refus.reason.message).toBe(MESSAGE_CONFLIT);
    expect(base.avis(ID).tentatives_appel).toBe(1);
    expect(base.suivis(ID)).toHaveLength(1);
  });
});

describe('statut et clôture (3.4)', () => {
  it('Résolu sans solution : 400, rien n’est écrit', async () => {
    const { base, service } = monter();
    await expect(
      service.statut(ID, { statut: AvisStatut.RESOLU, statut_lu: AvisStatut.A_RAPPELER }, AWA_AGENT, MAINTENANT),
    ).rejects.toThrow(MESSAGE_SOLUTION);
    expect(base.avis(ID).statut).toBe(AvisStatut.A_RAPPELER);
    expect(base.suivis(ID)).toHaveLength(0);
  });

  it('Résolu avec solution : dates posées, ligne « Statut « Résolu ». Solution : … »', async () => {
    const { base, service } = monter();
    await service.statut(
      ID,
      { statut: AvisStatut.RESOLU, solution: AvisSolution.GESTE_COMMERCIAL, statut_lu: AvisStatut.A_RAPPELER },
      AWA_AGENT,
      MAINTENANT,
    );
    expect(base.avis(ID)).toMatchObject({
      statut: AvisStatut.RESOLU,
      solution: AvisSolution.GESTE_COMMERCIAL,
      resolu_at: MAINTENANT,
      clos_at: MAINTENANT,
    });
    expect(base.suivis(ID)[0]).toMatchObject({
      type: AvisSuiviType.STATUT,
      statut_avant: AvisStatut.A_RAPPELER,
      statut_apres: AvisStatut.RESOLU,
      solution: AvisSolution.GESTE_COMMERCIAL,
    });
  });

  it('statut lu périmé : 409 sans écrire', async () => {
    const { base, service } = monter();
    await expect(
      service.statut(ID, { statut: AvisStatut.CLASSE, statut_lu: AvisStatut.NOUVEAU }, AWA_AGENT, MAINTENANT),
    ).rejects.toThrow(MESSAGE_CONFLIT);
    expect(base.avis(ID).statut).toBe(AvisStatut.A_RAPPELER);
  });

  it('claim : deux clôtures sur le même statut lu, la seconde 409', async () => {
    const { base, service } = monter();
    const [r1, r2] = await Promise.allSettled([
      service.statut(ID, { statut: AvisStatut.RESOLU, solution: AvisSolution.EXCUSES, statut_lu: AvisStatut.A_RAPPELER }, AWA_AGENT, MAINTENANT),
      service.statut(ID, { statut: AvisStatut.CLASSE, statut_lu: AvisStatut.A_RAPPELER }, COLLEGUE, MAINTENANT),
    ]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    expect((r2 as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(base.avis(ID).statut).toBe(AvisStatut.RESOLU);
    expect(base.suivis(ID)).toHaveLength(1);
  });

  it('réouverture d’un avis résolu : dates et solution vidées', async () => {
    const { base, service } = monter({
      statut: AvisStatut.RESOLU,
      solution: AvisSolution.EXCUSES,
      resolu_at: RECU,
      clos_at: RECU,
    });
    await service.statut(ID, { statut: AvisStatut.EN_COURS, statut_lu: AvisStatut.RESOLU }, AWA_AGENT, MAINTENANT);
    expect(base.avis(ID)).toMatchObject({ statut: AvisStatut.EN_COURS, solution: null, resolu_at: null, clos_at: null });
  });

  it('Incident ouvert à la main : 400', async () => {
    const { service } = monter();
    await expect(
      service.statut(ID, { statut: AvisStatut.INCIDENT_OUVERT, statut_lu: AvisStatut.A_RAPPELER }, AWA_AGENT, MAINTENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('commande cochée et agent (3.7)', () => {
  it('commande d’un autre client : 400 ; avis non rapproché : 400', async () => {
    const { service } = monter({ customer_id: CLIENT });
    await expect(service.commande(ID, { order_id: COMMANDE_AUTRE }, AWA_AGENT, MAINTENANT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const nonRapproche = monter();
    await expect(
      nonRapproche.service.commande(ID, { order_id: COMMANDE }, AWA_AGENT, MAINTENANT),
    ).rejects.toThrow('Client non rapproché.');
  });

  it('commande du client : cochée, puis décochée, chaque geste au journal', async () => {
    const { base, service } = monter({ customer_id: CLIENT });
    await service.commande(ID, { order_id: COMMANDE }, AWA_AGENT, MAINTENANT);
    expect(base.avis(ID).order_id).toBe(COMMANDE);
    await service.commande(ID, { order_id: null }, AWA_AGENT, MAINTENANT);
    expect(base.avis(ID).order_id).toBeNull();
    expect(base.suivis(ID).map((s) => s.meta)).toEqual([{ reference: 'CN-A1B2' }, null]);
  });

  it('agent hors de la liste de traitement : 400 ; agent valide : confié', async () => {
    const { base, service } = monter();
    await expect(service.agent(ID, { agent_id: 'u-mkt' }, ADMIN, MAINTENANT)).rejects.toBeInstanceOf(BadRequestException);
    await service.agent(ID, { agent_id: 'u-cc2' }, ADMIN, MAINTENANT);
    expect(base.avis(ID).agent_id).toBe('u-cc2');
    expect(base.suivis(ID)[0].meta).toEqual({ agent: 'Kouassi Ama' });
  });
});

describe('Créer un incident (3.7)', () => {
  const rapproche = { customer_id: CLIENT, order_id: COMMANDE };

  it('non rapproché : 400 ; sans commande cochée : 400 ; catégorie absente : 404', async () => {
    await expect(monter().service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT)).rejects.toThrow(
      'Client non rapproché.',
    );
    await expect(
      monter({ customer_id: CLIENT }).service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT),
    ).rejects.toThrow("Cocher d'abord la commande concernée.");
    await expect(
      monter(rapproche).service.ticket(ID, { categoryId: 'e0000000-0000-4000-8000-0000000000ff' }, AWA_AGENT, MAINTENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('succès : ticket rattaché au client et à la commande, message interne, « Incident ouvert », ligne au journal', async () => {
    const { base, service, tickets } = monter(rapproche);
    await service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT);
    expect(tickets.createTicket).toHaveBeenCalledWith({
      subject: 'Avis du 02/11 · Pas content · Yopougon',
      categoryId: CATEGORIE,
      priority: TicketPriority.HIGH,
      source: 'avis',
      customerId: CLIENT,
      orderId: COMMANDE,
      assigneeId: 'u-cc',
    });
    expect(base.prisma.ticketMessage.lignes[0]).toMatchObject({
      ticketId: 'ticket-1',
      authorUserId: 'u-cc',
      internal: true,
      meta: { avis_id: ID },
      body: 'Avis du 02/11 · 08:42 (Pas content, Manuel, Yopougon) : Frites froides.',
    });
    expect(base.avis(ID)).toMatchObject({ statut: AvisStatut.INCIDENT_OUVERT, ticket_id: 'ticket-1', ticket_demande_at: null });
    const ligne = base.suivis(ID).find((s) => s.type === AvisSuiviType.INCIDENT);
    expect(ligne?.meta).toMatchObject({ code: 'QUA-00012' });
  });

  it('priorité moyenne hors « Pas content »', async () => {
    const { tickets, service } = monter({ ...rapproche, ressenti: AvisRessenti.PEUT_MIEUX_FAIRE });
    await service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT);
    expect(tickets.createTicket).toHaveBeenCalledWith(expect.objectContaining({ priority: TicketPriority.MEDIUM }));
  });

  it('second clic pendant la création : 409, un seul ticket', async () => {
    const { tickets, service } = monter(rapproche);
    const resultats = await Promise.allSettled([
      service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT),
      service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT),
    ]);
    expect(resultats.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(tickets.createTicket).toHaveBeenCalledTimes(1);
    // Ticket déjà ouvert : 409 aussi.
    await expect(service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('échec du ticket : la demande est rendue, l’erreur remonte, un nouvel essai passe', async () => {
    const { base, service, tickets } = monter(rapproche);
    tickets.createTicket.mockRejectedValueOnce(new Error('base injoignable'));
    await expect(service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT)).rejects.toThrow(
      "Le ticket n'a pas pu être créé.",
    );
    expect(base.avis(ID)).toMatchObject({ ticket_demande_at: null, ticket_id: null, statut: AvisStatut.A_RAPPELER });
    await service.ticket(ID, { categoryId: CATEGORIE }, AWA_AGENT, MAINTENANT);
    expect(base.avis(ID).ticket_id).toBe('ticket-1');
  });
});

describe('suppression (3.8)', () => {
  it('contenu personnel effacé, notes vidées, DELETED, ligne « Avis supprimé. », cloche réécrite', async () => {
    const { base, service, lecture } = monter(
      { customer_id: CLIENT, order_id: COMMANDE },
      {
        notifications: [
          { id: 'n1', message: 'Awa · Yopougon : « Frites froides. »', data: { kind: 'avis', avis_id: ID } },
          { id: 'n2', message: 'Autre chose', data: { kind: 'avis', avis_id: 'autre' } },
        ],
      },
    );
    await service.journal(ID, { action: 'NOTE', note: 'Le client s’appelle Awa Koné.' }, AWA_AGENT, MAINTENANT);
    await service.supprimer(ID, ADMIN, MAINTENANT);

    expect(base.avis(ID)).toMatchObject({
      entity_status: 'DELETED',
      supprime_at: MAINTENANT,
      supprime_par_id: 'u-admin',
      commentaire: '',
      telephone: null,
      prenom: null,
      customer_id: null,
      order_id: null,
      // Gardés : date, ressenti, store, statut.
      created_at: RECU,
      ressenti: AvisRessenti.PAS_CONTENT,
      restaurant_id: 'resto-yop',
      statut: AvisStatut.A_RAPPELER,
    });
    expect(base.suivis(ID).filter((s) => s.note !== null || s.meta !== null)).toHaveLength(0);
    expect(base.suivis(ID).at(-1)).toMatchObject({ type: AvisSuiviType.SUPPRESSION, auteur_nom: 'Administrateur' });
    expect(base.prisma.notification.lignes.map((n) => n.message)).toEqual(['Avis supprimé.', 'Autre chose']);

    // Fiche en 404 ; une seconde suppression aussi.
    await expect(lecture.charger(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.supprimer(ID, ADMIN, MAINTENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('absent de la liste, des compteurs et de l’export : toutes leurs requêtes excluent DELETED', async () => {
    const requetes: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (morceaux: TemplateStringsArray, ...valeurs: unknown[]) => {
        requetes.push(Prisma.sql(morceaux, ...(valeurs as Prisma.Sql[])));
        return [];
      }),
      avisPrive: { findMany: jest.fn(async () => []) },
    };
    const lecture = new AvisPriveService(prisma as never);
    await lecture.liste({}, MAINTENANT);
    await lecture.compteurs(undefined, MAINTENANT);
    await lecture.exporter({}, MAINTENANT);
    expect(requetes).toHaveLength(4);
    for (const r of requetes) expect(r.sql).toContain("a.entity_status::text <> 'DELETED'");
  });
});

describe('fiche : rapprochement retenté à l’ouverture (3.5)', () => {
  it('le compte créé depuis l’envoi est rattaché, une seule ligne « Client rapproché automatiquement. »', async () => {
    const base = creerBaseAvis({
      avis: [{ ...avisParDefaut(), id: ID, ressenti: AvisRessenti.AU_TOP, canal: AvisCanal.APPLI, commentaire: 'Top.', telephone: '+2250707000001', created_at: RECU }],
      customers: [{ id: CLIENT, phone: '+2250707000001', first_name: 'Awa', entity_status: 'ACTIVE', created_at: MAINTENANT }],
    });
    const lecture = new AvisPriveService(base.prisma as never);
    const user = { id: 'u-cc', role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE } as User;

    const [f1, f2] = await Promise.all([lecture.fiche(ID, user, MAINTENANT), lecture.fiche(ID, user, MAINTENANT)]);
    expect(base.avis(ID)).toMatchObject({ customer_id: CLIENT, rapproche_at: MAINTENANT });
    expect(base.suivis(ID).map((s) => s.note)).toEqual([TEXTE_RAPPROCHEMENT]);
    expect(f1.rapproche && f2.rapproche).toBe(true);
    expect(f1.prenom).toBe('Awa');
  });
});
