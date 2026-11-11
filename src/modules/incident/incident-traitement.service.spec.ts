import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { COMPTES, Ligne, jeuIncidents } from './incident-base-simulee-spec';
import { IncidentTraitementService } from './incident-traitement.service';
import {
  MESSAGE_AGENT,
  MESSAGE_AVIS_COMMANDE,
  MESSAGE_AVIS_DEJA,
  MESSAGE_AVIS_SIEGE,
  MESSAGE_BON_INTERDIT,
  MESSAGE_BON_MONTANT,
  MESSAGE_BON_SANS_OBJET,
  MESSAGE_CATEGORIE,
  MESSAGE_COMMANDE_AUTRE,
  MESSAGE_CONFLIT,
  MESSAGE_DOUBLON,
  MESSAGE_DROIT,
  MESSAGE_LIEN,
  MESSAGE_NOTE_DEJA,
  MESSAGE_ORIGINE,
  MESSAGE_REACTION,
  MESSAGE_SMS_RECENT,
  MESSAGE_STATUT,
} from './incident.rules';
import { IncidentService } from './incident.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAINTENANT = new Date('2026-11-11T10:00:00.000Z');
const plusTard = (minutes: number) => new Date(MAINTENANT.getTime() + minutes * 60_000);
const compte = (c: Ligne) => c as unknown as User;

function monter(plus: Parameters<typeof jeuIncidents>[0] = {}, reglages: Record<string, string> = {}) {
  const base = jeuIncidents(plus);
  const settings = { getMany: jest.fn(async () => reglages), set: jest.fn() };
  let bons = 0;
  const vouchers = {
    createForCustomer: jest.fn(async (p: { customerId: string; amount: number; createdBy: string; expiresAt: Date }) => {
      const bon = {
        id: `bon-${++bons}`,
        code: `CNTEST0${bons}`,
        initial_amount: p.amount,
        status: 'ACTIVE',
        expires_at: p.expiresAt,
        customer_id: p.customerId,
        created_by: p.createdBy,
      };
      base.prisma.voucher.lignes.push(bon);
      return bon;
    }),
  };
  const twilio = { sendSmsMessage: jest.fn(async () => ({ sid: 'SM1' }) as any) };
  const alertes = { diffuser: jest.fn(), nouveau: jest.fn(async () => undefined), resolu: jest.fn(async () => undefined), retard: jest.fn() };
  const incidents = new IncidentService(base.prisma as any, settings as any);
  const service = new IncidentTraitementService(base.prisma as any, incidents, vouchers as any, twilio as any, alertes as any);
  return { base, service, incidents, vouchers, twilio, alertes, settings };
}

const signalement = (plus: Ligne = {}) =>
  ({
    order_id: 'commande-1',
    categorie_id: 'cat-qualite',
    gravite: 'MOYENNE',
    origine: 'APPEL',
    description: 'Poulet servi tiède, la cliente a rappelé.',
    ...plus,
  }) as any;

const refus = async (geste: Promise<unknown>) => {
  try {
    await geste;
  } catch (erreur) {
    const e = erreur as HttpException;
    const reponse = e.getResponse?.();
    return {
      statut: e.getStatus?.(),
      message: typeof reponse === 'string' ? reponse : (reponse as { message?: string })?.message,
      corps: reponse as any,
    };
  }
  throw new Error('le geste aurait dû être refusé');
};

describe('incidents : signaler', () => {
  it('ouvre un incident avec son code, son responsable et son échéance, et prévient le pôle', async () => {
    const { base, service, alertes } = monter();
    const fiche = await service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);

    expect(fiche.code).toBe('INC-261111-001');
    expect(fiche).toMatchObject({
      statut: 'OUVERT',
      gravite: 'MOYENNE',
      origine: 'APPEL',
      pole: 'RESTAURANT',
      categorie: { id: 'cat-qualite', nom: 'Qualité du plat' },
      description: 'Poulet servi tiède, la cliente a rappelé.',
      restaurant: { id: 'resto-1', name: 'Angré' },
      client: { nom: 'Awa Koné', telephone: '+2250707000001' },
      signale_par: 'Ruth Fetai',
      agent: null,
      en_retard: false,
    });
    expect(fiche.commande).toMatchObject({ reference: 'ORD-261110-50950', montant: 5500, statut: 'COMPLETED' });
    expect(fiche.echeance_at.toISOString()).toBe('2026-11-12T10:00:00.000Z');
    expect(fiche.suivis.map((s) => s.texte)).toEqual(['Signalé par Ruth Fetai (Appel)']);

    const ligne = base.incident(fiche.id);
    expect(ligne).toMatchObject({ restaurant_id: 'resto-1', customer_id: 'client-1', signale_par_id: 'u-cc' });
    expect(alertes.nouveau).toHaveBeenCalledWith(expect.objectContaining({ id: fiche.id, pole: 'RESTAURANT' }), 'u-cc');
    expect(alertes.diffuser).toHaveBeenCalledTimes(1);
  });

  it('numérote dans la journée', async () => {
    const { service } = monter();
    const un = await service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const deux = await service.signaler(signalement({ categorie_id: 'cat-retard' }), compte(COMPTES.callCenter), plusTard(5));
    const lendemain = await service.signaler(
      signalement({ order_id: 'commande-3' }),
      compte(COMPTES.callCenter),
      new Date('2026-11-12T08:00:00.000Z'),
    );
    expect([un.code, deux.code, lendemain.code]).toEqual(['INC-261111-001', 'INC-261111-002', 'INC-261112-001']);
    expect(deux.pole).toBe('LIVRAISON');
  });

  it('refuse un second incident ouvert sur la même commande et la même catégorie, et rend le premier', async () => {
    const { service, base } = monter();
    const premier = await service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const r = await refus(service.signaler(signalement({ origine: 'WHATSAPP' }), compte(COMPTES.caissier), plusTard(1)));
    expect(r.statut).toBe(409);
    expect(r.corps).toMatchObject({ message: MESSAGE_DOUBLON, code: 'INCIDENT_DOUBLON', incident: { id: premier.id, code: premier.code } });
    expect(base.prisma.incident.lignes).toHaveLength(1);
  });

  it('une fois le premier clôturé, la même commande peut être signalée de nouveau', async () => {
    const { service, base } = monter();
    const premier = await service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    base.incident(premier.id).statut = 'CLOTURE';
    const second = await service.signaler(signalement(), compte(COMPTES.callCenter), plusTard(60));
    expect(second.code).toBe('INC-261111-002');
  });

  it('un point de vente ne signale que sur ses commandes ; le marketing ne signale pas', async () => {
    const { service } = monter();
    const autre = await refus(service.signaler(signalement({ order_id: 'commande-2' }), compte(COMPTES.caissier), MAINTENANT));
    expect(autre).toMatchObject({ statut: 403, message: MESSAGE_COMMANDE_AUTRE });
    const marketing = await refus(service.signaler(signalement(), compte(COMPTES.marketing), MAINTENANT));
    expect(marketing).toMatchObject({ statut: 403, message: MESSAGE_DROIT });
    const sienne = await service.signaler(signalement({ origine: 'SUR_PLACE' }), compte(COMPTES.caissier), MAINTENANT);
    expect(sienne.origine).toBe('SUR_PLACE');
  });

  it('refuse une catégorie désactivée, une origine absente, une description trop courte', async () => {
    const { service } = monter();
    expect(await refus(service.signaler(signalement({ categorie_id: 'cat-ancienne' }), compte(COMPTES.admin), MAINTENANT))).toMatchObject({
      statut: 404,
      message: MESSAGE_CATEGORIE,
    });
    expect(await refus(service.signaler(signalement({ origine: undefined }), compte(COMPTES.admin), MAINTENANT))).toMatchObject({
      statut: 400,
      message: MESSAGE_ORIGINE,
    });
    expect((await refus(service.signaler(signalement({ description: 'non' }), compte(COMPTES.admin), MAINTENANT))).statut).toBe(400);
  });

  it("deux signalements au même instant : le code pris est retenté, la commande n'a qu'un incident", async () => {
    const { service, base } = monter();
    const collision = new Prisma.PrismaClientKnownRequestError('code pris', { code: 'P2002', clientVersion: 'test', meta: { target: ['code'] } });
    base.prisma.incident.create.mockImplementationOnce(async () => {
      throw collision;
    });
    const fiche = await service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche.code).toBe('INC-261111-001');
    expect(base.prisma.incident.create).toHaveBeenCalledTimes(2);

    const doublon = new Prisma.PrismaClientKnownRequestError('index partiel', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'Incident_commande_categorie_ouvert_key' },
    });
    base.prisma.incident.create.mockImplementationOnce(async () => {
      throw doublon;
    });
    const r = await refus(service.signaler(signalement({ order_id: 'commande-3' }), compte(COMPTES.callCenter), plusTard(1)));
    expect(r).toMatchObject({ statut: 409, message: MESSAGE_DOUBLON });
  });
});

describe('incidents : signaler depuis un ticket, une note, un avis', () => {
  it("depuis un ticket : l'origine est le ticket, et le ticket doit porter sur la commande", async () => {
    const { service, base } = monter({
      tickets: [
        { id: 'ticket-1', code: 'LIV-00012', orderId: 'commande-1' },
        { id: 'ticket-2', code: 'LIV-00013', orderId: 'commande-2' },
      ],
    });
    const fiche = await service.signaler(signalement({ ticket_id: 'ticket-1', origine: undefined }), compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche.origine).toBe('TICKET');
    expect(fiche.liens.ticket).toEqual({ id: 'ticket-1', code: 'LIV-00012' });
    expect(base.incident(fiche.id).ticket_id).toBe('ticket-1');

    const autre = await refus(
      service.signaler(signalement({ ticket_id: 'ticket-2', categorie_id: 'cat-retard' }), compte(COMPTES.callCenter), MAINTENANT),
    );
    expect(autre).toMatchObject({ statut: 400, message: MESSAGE_LIEN });
  });

  it('depuis une note après commande : une note ouvre un incident au plus', async () => {
    const { service } = monter({ comments: [{ id: 'note-1', order_id: 'commande-1', rating: 1 }] });
    const fiche = await service.signaler(signalement({ comment_id: 'note-1', origine: undefined }), compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche.origine).toBe('NOTE');
    expect(fiche.liens.note).toEqual({ id: 'note-1', rating: 1 });

    const encore = await refus(
      service.signaler(signalement({ comment_id: 'note-1', categorie_id: 'cat-retard' }), compte(COMPTES.callCenter), plusTard(1)),
    );
    expect(encore).toMatchObject({ statut: 409, message: MESSAGE_NOTE_DEJA });
    expect(encore.corps.incident).toMatchObject({ id: fiche.id });

    const ailleurs = await refus(
      service.signaler(signalement({ comment_id: 'note-1', order_id: 'commande-3' }), compte(COMPTES.callCenter), plusTard(2)),
    );
    expect(ailleurs).toMatchObject({ statut: 400, message: MESSAGE_LIEN });
  });

  it("depuis un avis du site : réservé au siège, la commande doit être cochée, l'avis passe « Incident ouvert »", async () => {
    const { service, base } = monter({
      avis: [
        { id: 'avis-1', statut: 'A_RAPPELER', order_id: 'commande-1', entity_status: 'ACTIVE', accord_rappel: true },
        { id: 'avis-2', statut: 'NOUVEAU', order_id: null, entity_status: 'ACTIVE', accord_rappel: false },
      ],
    });
    expect(
      await refus(service.signaler(signalement({ avis_id: 'avis-1' }), compte(COMPTES.manager), MAINTENANT)),
    ).toMatchObject({ statut: 403, message: MESSAGE_AVIS_SIEGE });
    expect(
      await refus(service.signaler(signalement({ avis_id: 'avis-2' }), compte(COMPTES.callCenter), MAINTENANT)),
    ).toMatchObject({ statut: 400, message: MESSAGE_AVIS_COMMANDE });

    const fiche = await service.signaler(signalement({ avis_id: 'avis-1', origine: undefined, gravite: 'HAUTE' }), compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche.origine).toBe('AVIS');
    expect(fiche.liens.avis_id).toBe('avis-1');
    expect(base.avis('avis-1').statut).toBe('INCIDENT_OUVERT');
    expect(base.suivisAvis('avis-1')).toEqual([
      expect.objectContaining({
        type: 'INCIDENT',
        statut_avant: 'A_RAPPELER',
        statut_apres: 'INCIDENT_OUVERT',
        meta: { code: fiche.code, incident_id: fiche.id },
        auteur_nom: 'Ruth Fetai',
      }),
    ]);

    const encore = await refus(
      service.signaler(signalement({ avis_id: 'avis-1', categorie_id: 'cat-retard' }), compte(COMPTES.callCenter), plusTard(1)),
    );
    expect(encore).toMatchObject({ statut: 409, message: MESSAGE_AVIS_DEJA });
  });
});

describe('incidents : prendre en charge, confier', () => {
  const ouvert = async (m: ReturnType<typeof monter>, plus: Ligne = {}) =>
    m.service.signaler(signalement(plus), compte(COMPTES.callCenter), MAINTENANT);

  it('le manager prend en charge l’incident de son restaurant : En cours, à son nom', async () => {
    const m = monter();
    const i = await ouvert(m);
    const fiche = await m.service.assigner(i.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.manager), plusTard(10));
    expect(fiche).toMatchObject({ statut: 'EN_COURS', agent: { id: 'u-manager', fullname: 'Mariam Manager' }, pole: 'RESTAURANT' });
    expect(fiche.suivis.at(-1)?.texte).toBe('Pris en charge par Mariam Manager');
    expect(fiche.droits.prendre).toBe(false);
  });

  it("refuse la prise en charge d'un incident de la livraison par le manager, et celle d'un autre restaurant", async () => {
    const m = monter();
    const livraison = await ouvert(m, { categorie_id: 'cat-retard' });
    expect(await refus(m.service.assigner(livraison.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.manager), MAINTENANT))).toMatchObject({
      statut: 403,
      message: MESSAGE_DROIT,
    });
    const r = await refus(m.service.assigner(livraison.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.managerFaya), MAINTENANT));
    expect(r.statut).toBe(403);
    expect(m.base.incident(livraison.id).statut).toBe('OUVERT');
  });

  it("le statut lu n'est plus le bon : refus, rien n'est écrit", async () => {
    const m = monter();
    const i = await ouvert(m);
    await m.service.assigner(i.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.manager), MAINTENANT);
    const r = await refus(m.service.assigner(i.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.callCenter), MAINTENANT));
    expect(r).toMatchObject({ statut: 409, message: MESSAGE_CONFLIT });
    expect(m.base.incident(i.id).agent_id).toBe('u-manager');
  });

  it('deux prises en charge lancées ensemble : une seule aboutit', async () => {
    const m = monter();
    const i = await ouvert(m, { categorie_id: 'cat-paiement' });
    const resultats = await Promise.allSettled([
      m.service.assigner(i.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.callCenter), MAINTENANT),
      m.service.assigner(i.id, { statut_lu: 'OUVERT' } as any, compte(COMPTES.callCenter2), MAINTENANT),
    ]);
    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejet = resultats.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejet.reason).toBeInstanceOf(ConflictException);
    expect(m.base.suivis(i.id).filter((s) => s.type === 'ASSIGNATION')).toHaveLength(1);
  });

  it('le siège change le responsable : le nouveau pôle est prévenu, personne ne répond encore', async () => {
    const m = monter();
    const i = await ouvert(m);
    m.alertes.nouveau.mockClear();
    const fiche = await m.service.assigner(i.id, { statut_lu: 'OUVERT', pole: 'LIVRAISON' } as any, compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche).toMatchObject({ statut: 'OUVERT', pole: 'LIVRAISON', agent: null });
    expect(fiche.suivis.at(-1)?.texte).toBe('Confié à : Livraison, par Ruth Fetai');
    expect(m.alertes.nouveau).toHaveBeenCalledWith(expect.objectContaining({ id: i.id, pole: 'LIVRAISON' }), 'u-cc');
  });

  it('le siège confie à un agent du siège : En cours ; à un compte de restaurant : refus', async () => {
    const m = monter();
    const i = await ouvert(m, { categorie_id: 'cat-paiement' });
    const r = await refus(m.service.assigner(i.id, { statut_lu: 'OUVERT', agent_id: 'u-manager' } as any, compte(COMPTES.admin), MAINTENANT));
    expect(r).toMatchObject({ statut: 400, message: MESSAGE_AGENT });

    const fiche = await m.service.assigner(i.id, { statut_lu: 'OUVERT', agent_id: 'u-cc2' } as any, compte(COMPTES.admin), MAINTENANT);
    expect(fiche).toMatchObject({ statut: 'EN_COURS', agent: { id: 'u-cc2' }, pole: 'CALL_CENTER' });
    expect(fiche.suivis.at(-1)?.texte).toBe('Confié à : Call center, Ange Yoboué, par Cédric Assah');

    const retire = await m.service.assigner(i.id, { statut_lu: 'EN_COURS', agent_id: null } as any, compte(COMPTES.admin), plusTard(1));
    expect(retire).toMatchObject({ statut: 'OUVERT', agent: null });
  });

  it('le manager ne change pas le responsable', async () => {
    const m = monter();
    const i = await ouvert(m);
    const r = await refus(m.service.assigner(i.id, { statut_lu: 'OUVERT', pole: 'LIVRAISON' } as any, compte(COMPTES.manager), MAINTENANT));
    expect(r).toMatchObject({ statut: 403, message: MESSAGE_DROIT });
  });
});

describe('incidents : résoudre', () => {
  const resolution = (plus: Ligne = {}) =>
    ({
      statut_lu: 'OUVERT',
      cause: 'Commande préparée avant l’arrivée du livreur.',
      action: 'Mise en sac au départ du livreur.',
      geste: 'EXCUSES',
      ...plus,
    }) as any;

  it('sans bon : résolu, avec la cause, l’action et le geste ; le call center est prévenu', async () => {
    const m = monter();
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const fiche = await m.service.resoudre(i.id, resolution(), compte(COMPTES.manager), plusTard(120));
    expect(fiche).toMatchObject({
      statut: 'RESOLU',
      cause: 'Commande préparée avant l’arrivée du livreur.',
      action: 'Mise en sac au départ du livreur.',
      geste: 'EXCUSES',
      bon: null,
      bon_a_creer: false,
      resolu_par: 'Mariam Manager',
      // Personne n'avait pris l'incident : qui le résout en répond.
      agent: { id: 'u-manager' },
    });
    expect(fiche.resolu_at?.toISOString()).toBe(plusTard(120).toISOString());
    expect(fiche.suivis.at(-1)?.texte).toBe('Résolu par Mariam Manager : excuses');
    expect(m.vouchers.createForCustomer).not.toHaveBeenCalled();
    expect(m.alertes.resolu).toHaveBeenCalledWith(expect.objectContaining({ id: i.id, geste: 'EXCUSES' }), 'u-manager');
    expect(fiche.droits).toMatchObject({ resoudre: false, cloturer: true });
  });

  it('avec un bon : le bon est créé pour le client, valable 30 jours, et son code part par SMS', async () => {
    const m = monter();
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const fiche = await m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 2000 }), compte(COMPTES.callCenter), plusTard(60));

    expect(m.vouchers.createForCustomer).toHaveBeenCalledTimes(1);
    expect(m.vouchers.createForCustomer).toHaveBeenCalledWith({
      customerId: 'client-1',
      amount: 2000,
      createdBy: 'u-cc',
      expiresAt: new Date('2026-12-11T11:00:00.000Z'),
    });
    expect(fiche.bon).toMatchObject({ code: 'CNTEST01', montant: 2000, statut: 'ACTIVE', message_canal: 'SMS' });
    expect(fiche.bon_montant).toBe(2000);
    expect(m.twilio.sendSmsMessage).toHaveBeenCalledWith({
      phoneNumber: '+2250707000001',
      message: expect.stringContaining('code CNTEST01'),
    });
    expect(fiche.suivis.slice(-3).map((s) => s.texte)).toEqual([
      'Résolu par Ruth Fetai : bon de réduction',
      "Bon CNTEST01 de 2 000 F créé, valable jusqu'au 11/12/2026",
      'Code du bon envoyé au client par SMS',
    ]);
  });

  it('un montant hors barème est refusé ; la validité suit le réglage', async () => {
    const m = monter({}, { 'incident.bon_validite_jours': '7', 'incident.bon_haute': '5000' });
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const r = await refus(m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 3000 }), compte(COMPTES.callCenter), MAINTENANT));
    expect(r).toMatchObject({ statut: 400, message: MESSAGE_BON_MONTANT });
    expect(m.base.incident(i.id).statut).toBe('OUVERT');

    await m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 5000 }), compte(COMPTES.callCenter), MAINTENANT);
    expect(m.vouchers.createForCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 5000, expiresAt: new Date('2026-11-18T10:00:00.000Z') }),
    );
  });

  it('le manager offre un bon seulement si le réglage le permet', async () => {
    const interdit = monter({}, { 'incident.bon_restaurant': 'false' });
    const i = await interdit.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    expect(i.droits.bon).toBe(true);
    const r = await refus(interdit.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 1000 }), compte(COMPTES.manager), MAINTENANT));
    expect(r).toMatchObject({ statut: 400, message: MESSAGE_BON_INTERDIT });
    expect(interdit.vouchers.createForCustomer).not.toHaveBeenCalled();

    const permis = monter();
    const j = await permis.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const fiche = await permis.service.resoudre(j.id, resolution({ geste: 'BON', bon_montant: 1000 }), compte(COMPTES.manager), MAINTENANT);
    expect(fiche.bon).toMatchObject({ montant: 1000 });
  });

  it('le bon ne peut pas être créé : l’incident reste résolu, la fiche propose de créer le bon', async () => {
    const m = monter();
    m.vouchers.createForCustomer.mockRejectedValueOnce(new Error('base indisponible'));
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const fiche = await m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 2000 }), compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche).toMatchObject({ statut: 'RESOLU', geste: 'BON', bon: null, bon_a_creer: true });
    expect(fiche.suivis.at(-1)?.texte).toBe("Le bon n'a pas pu être créé");
    expect(m.twilio.sendSmsMessage).not.toHaveBeenCalled();
    expect(m.base.incident(i.id).bon_demande_at).toBeNull();

    const repris = await m.service.creerBon(i.id, compte(COMPTES.callCenter), plusTard(5));
    expect(repris).toMatchObject({ bon_a_creer: false, bon: { code: 'CNTEST01', montant: 2000 } });
    expect(await refus(m.service.creerBon(i.id, compte(COMPTES.callCenter), plusTard(6)))).toMatchObject({
      statut: 400,
      message: MESSAGE_BON_SANS_OBJET,
    });
    expect(m.vouchers.createForCustomer).toHaveBeenCalledTimes(2);
  });

  it('le SMS ne part pas : le bon existe, la fiche le dit', async () => {
    const m = monter();
    m.twilio.sendSmsMessage.mockResolvedValueOnce(null as any);
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const fiche = await m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 2000 }), compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche.bon).toMatchObject({ code: 'CNTEST01', message_canal: 'AUCUN' });
    expect(fiche.suivis.at(-1)?.texte).toBe("Le SMS du bon n'est pas parti");
  });

  it('deux résolutions lancées ensemble : une seule aboutit, un seul bon', async () => {
    const m = monter();
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const resultats = await Promise.allSettled([
      m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 2000 }), compte(COMPTES.callCenter), MAINTENANT),
      m.service.resoudre(i.id, resolution({ geste: 'BON', bon_montant: 3000 }), compte(COMPTES.admin), MAINTENANT),
    ]);
    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(m.vouchers.createForCustomer).toHaveBeenCalledTimes(1);
    expect(m.base.prisma.voucher.lignes).toHaveLength(1);
  });

  it('un incident déjà résolu ne se résout pas deux fois ; le caissier ne résout pas', async () => {
    const m = monter();
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    expect(await refus(m.service.resoudre(i.id, resolution(), compte(COMPTES.caissier), MAINTENANT))).toMatchObject({
      statut: 403,
      message: MESSAGE_DROIT,
    });
    await m.service.resoudre(i.id, resolution(), compte(COMPTES.callCenter), MAINTENANT);
    expect(await refus(m.service.resoudre(i.id, resolution({ statut_lu: 'RESOLU' }), compte(COMPTES.callCenter), MAINTENANT))).toMatchObject({
      statut: 409,
      message: MESSAGE_STATUT,
    });
  });
});

describe('incidents : clôturer, rouvrir, noter, renvoyer le SMS', () => {
  const resolu = async (m: ReturnType<typeof monter>, plus: Ligne = {}, geste: Ligne = { geste: 'BON', bon_montant: 2000 }) => {
    const i = await m.service.signaler(signalement(plus), compte(COMPTES.callCenter), MAINTENANT);
    return m.service.resoudre(
      i.id,
      { statut_lu: 'OUVERT', cause: 'Oubli à la préparation.', action: 'Liste de contrôle.', ...geste } as any,
      compte(COMPTES.callCenter),
      plusTard(30),
    );
  };

  it('clôture après le rappel du client, dont la réaction est notée', async () => {
    const m = monter();
    const i = await resolu(m);
    expect(await refus(m.service.cloturer(i.id, { statut_lu: 'RESOLU', recontact: 'INFORME' } as any, compte(COMPTES.callCenter), plusTard(60)))).toMatchObject({
      statut: 400,
      message: MESSAGE_REACTION,
    });
    const fiche = await m.service.cloturer(
      i.id,
      { statut_lu: 'RESOLU', recontact: 'INFORME', reaction: 'Satisfaite du geste, recommandera.' } as any,
      compte(COMPTES.callCenter2),
      plusTard(60),
    );
    expect(fiche).toMatchObject({
      statut: 'CLOTURE',
      recontact: 'INFORME',
      reaction: 'Satisfaite du geste, recommandera.',
      cloture_par: 'Ange Yoboué',
    });
    expect(fiche.suivis.at(-1)).toMatchObject({ texte: 'Clôturé par Ange Yoboué : client informé', note: 'Satisfaite du geste, recommandera.' });
    expect(fiche.droits).toMatchObject({ cloturer: false, rouvrir: true, resoudre: false });
  });

  it("un incident pas encore résolu ne se clôture pas", async () => {
    const m = monter();
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const r = await refus(m.service.cloturer(i.id, { statut_lu: 'OUVERT', recontact: 'SANS_RECONTACT' } as any, compte(COMPTES.callCenter), MAINTENANT));
    expect(r).toMatchObject({ statut: 409, message: MESSAGE_STATUT });
  });

  it("l'avis du site encore « Incident ouvert » est résolu avec son incident, avec la solution du geste", async () => {
    const m = monter({ avis: [{ id: 'avis-1', statut: 'NOUVEAU', order_id: 'commande-1', entity_status: 'ACTIVE', accord_rappel: true }] });
    const i = await resolu(m, { avis_id: 'avis-1' });
    await m.service.cloturer(i.id, { statut_lu: 'RESOLU', recontact: 'INJOIGNABLE' } as any, compte(COMPTES.callCenter), plusTard(90));
    expect(m.base.avis('avis-1')).toMatchObject({ statut: 'RESOLU', solution: 'GESTE_COMMERCIAL' });
    expect(m.base.avis('avis-1').clos_at.toISOString()).toBe(plusTard(90).toISOString());
    expect(m.base.suivisAvis('avis-1').at(-1)).toMatchObject({
      type: 'STATUT',
      statut_avant: 'INCIDENT_OUVERT',
      statut_apres: 'RESOLU',
      solution: 'GESTE_COMMERCIAL',
      meta: { code: i.code },
    });
  });

  it("un avis que l'agent a déjà classé autrement n'est pas touché par la clôture", async () => {
    const m = monter({ avis: [{ id: 'avis-1', statut: 'NOUVEAU', order_id: 'commande-1', entity_status: 'ACTIVE', accord_rappel: false }] });
    const i = await resolu(m, { avis_id: 'avis-1' }, { geste: 'EXCUSES' });
    m.base.avis('avis-1').statut = 'CLASSE';
    await m.service.cloturer(i.id, { statut_lu: 'RESOLU', recontact: 'SANS_RECONTACT' } as any, compte(COMPTES.callCenter), plusTard(90));
    expect(m.base.avis('avis-1').statut).toBe('CLASSE');
    expect(m.base.suivisAvis('avis-1').filter((s) => s.type === 'STATUT')).toHaveLength(0);
  });

  it('le siège rouvre : En cours, nouveau délai, clôture effacée ; le bon reste, jamais de second bon', async () => {
    const m = monter({ avis: [{ id: 'avis-1', statut: 'NOUVEAU', order_id: 'commande-1', entity_status: 'ACTIVE', accord_rappel: true }] });
    const i = await resolu(m, { avis_id: 'avis-1' });
    await m.service.cloturer(i.id, { statut_lu: 'RESOLU', recontact: 'INFORME', reaction: 'Toujours mécontente.' } as any, compte(COMPTES.callCenter), plusTard(60));

    expect(await refus(m.service.rouvrir(i.id, { statut_lu: 'CLOTURE', motif: 'La cliente a rappelé.' } as any, compte(COMPTES.manager), plusTard(70)))).toMatchObject({
      statut: 403,
      message: MESSAGE_DROIT,
    });
    const rouvert = await m.service.rouvrir(i.id, { statut_lu: 'CLOTURE', motif: 'La cliente a rappelé.' } as any, compte(COMPTES.admin), plusTard(120));
    expect(rouvert).toMatchObject({
      statut: 'EN_COURS',
      resolu_at: null,
      cloture_at: null,
      recontact: null,
      reaction: null,
      // Repris tels quels à la prochaine résolution.
      cause: 'Oubli à la préparation.',
      geste: 'BON',
      bon: { code: 'CNTEST01', montant: 2000 },
    });
    expect(rouvert.echeance_at.toISOString()).toBe(new Date(plusTard(120).getTime() + 24 * 3_600_000).toISOString());
    expect(rouvert.suivis.at(-1)).toMatchObject({ texte: 'Rouvert par Cédric Assah', note: 'La cliente a rappelé.' });
    // L'avis résolu avec l'incident le suit.
    expect(m.base.avis('avis-1').statut).toBe('INCIDENT_OUVERT');

    const encore = await m.service.resoudre(
      i.id,
      { statut_lu: 'EN_COURS', cause: 'Second passage.', action: 'Rappel du store.', geste: 'BON', bon_montant: 3000 } as any,
      compte(COMPTES.admin),
      plusTard(130),
    );
    expect(encore.bon).toMatchObject({ code: 'CNTEST01', montant: 2000 });
    expect(encore.bon_montant).toBe(2000);
    expect(m.vouchers.createForCustomer).toHaveBeenCalledTimes(1);
  });

  it('une note : qui sert la commande peut en écrire, le marketing non, un autre restaurant non plus', async () => {
    const m = monter();
    const i = await m.service.signaler(signalement(), compte(COMPTES.callCenter), MAINTENANT);
    const fiche = await m.service.noter(i.id, { note: ' La cliente repasse demain. ' } as any, compte(COMPTES.caissier), plusTard(5));
    expect(fiche.suivis.at(-1)).toMatchObject({ texte: 'Note de Koffi Caissier', note: 'La cliente repasse demain.' });
    await expect(m.service.noter(i.id, { note: 'x' } as any, compte(COMPTES.marketing), MAINTENANT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.service.noter(i.id, { note: 'x' } as any, compte(COMPTES.managerFaya), MAINTENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('le SMS du code se renvoie, pas deux fois en deux minutes', async () => {
    const m = monter();
    const i = await resolu(m);
    expect(m.twilio.sendSmsMessage).toHaveBeenCalledTimes(1);
    const tropTot = await refus(m.service.renvoyerSms(i.id, compte(COMPTES.callCenter), plusTard(31)));
    expect(tropTot).toMatchObject({ statut: 409, message: MESSAGE_SMS_RECENT });
    const fiche = await m.service.renvoyerSms(i.id, compte(COMPTES.callCenter), plusTard(40));
    expect(m.twilio.sendSmsMessage).toHaveBeenCalledTimes(2);
    expect(fiche.suivis.at(-1)?.texte).toBe('Code du bon envoyé au client par SMS');
  });

  it('pas de bon : rien à renvoyer', async () => {
    const m = monter();
    const i = await resolu(m, {}, { geste: 'EXCUSES' });
    expect((await refus(m.service.renvoyerSms(i.id, compte(COMPTES.callCenter), plusTard(40)))).statut).toBe(400);
  });
});
