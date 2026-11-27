import { HttpException } from '@nestjs/common';
import { CallStatus, CourseStatut, DeliveryStatut, UserRole } from '@prisma/client';

import {
  CALLS_CLIENTS_ACTIF_KEY,
  CALLS_LIVREURS_ACTIF_KEY,
  SONNERIE_LIVREUR_MS,
  TTL_JETON_CLIENT_S,
} from '../constants/calls.constants';
import {
  client,
  clientConnecte,
  commande,
  connecte,
  course,
  livreur,
  membre,
  monterAppels,
} from './base-appels.simulee-spec';

/**
 * Appels dans l'appli Chicken Nation (demande du 26/11) : le client appelle
 * le service client ou le livreur de sa commande, le service client appelle
 * un client. Base, Lunion Meet, passerelle et notifications simulés
 * (base-appels.simulee-spec.ts).
 */

async function refus(promesse: Promise<unknown>): Promise<{ statut: number; corps: any }> {
  try {
    await promesse;
  } catch (e) {
    if (e instanceof HttpException) return { statut: e.getStatus(), corps: e.getResponse() };
    throw e;
  }
  throw new Error('refus attendu');
}

describe('Appels avec les clients', () => {
  const MAINTENANT = new Date('2026-11-26T12:00:00Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(MAINTENANT);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function scene(reglages: Record<string, string> = {}, options: { appliPrete?: boolean } = {}) {
    const fatou = membre({ fullname: 'Fatou Bamba' });
    const yao = membre({ fullname: 'Yao Brou' });
    const admin = membre({ fullname: 'Admin', role: UserRole.ADMIN });
    const marketing = membre({ fullname: 'Marketing', role: UserRole.MARKETING });
    const koffi = livreur();
    const awa = client({
      appels_appli_at: options.appliPrete === false ? null : new Date(MAINTENANT.getTime() - 3600_000),
      notification_settings: { expo_push_token: 'ExponentPushToken[awa]', push: true, active: true },
    });
    const moussa = client({ first_name: 'Moussa', last_name: 'Diallo', phone: '+2250101010101' });
    const cmd = commande({ customer_id: awa.id, reference: 'ORD-261126-00042' });
    const cmdMoussa = commande({ customer_id: moussa.id, reference: 'ORD-261126-00043' });
    const crs = course({ deliverer_id: koffi.id, reference: 'CRS-A1', statut: CourseStatut.IN_DELIVERY });
    const livraisons = [
      { id: 'liv-1', order_id: cmd.id, course_id: crs.id, statut: DeliveryStatut.IN_ROUTE },
      { id: 'liv-2', order_id: cmdMoussa.id, course_id: crs.id, statut: DeliveryStatut.DELIVERED },
    ];
    const t = monterAppels({
      personnel: [fatou, yao, admin, marketing],
      livreurs: [koffi],
      courses: [crs],
      livraisons,
      clients: [awa, moussa],
      commandes: [cmd, cmdMoussa],
      reglages,
    });
    return { ...t, fatou, yao, admin, marketing, koffi, awa, moussa, cmd, cmdMoussa, crs, livraisons };
  }

  // ============================================================
  // LE CLIENT APPELLE LE SERVICE CLIENT
  // ============================================================

  describe('le client appelle le service client', () => {
    it('fait sonner le centre d’appels avec le client et sa commande ; l’agent qui décroche est mis en ligne', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), { order_id: t.cmd.id });

      expect(res.access).toEqual({
        room: 'salle-1',
        token: 'jeton:salle-1:client-' + t.awa.id,
        url: 'wss://sfu.lunion.test',
        identity: 'client-' + t.awa.id,
      });
      expect(t.lunion.createToken).toHaveBeenCalledWith('salle-1', 'client-' + t.awa.id, 'Awa Koné', TTL_JETON_CLIENT_S);
      expect(res).toMatchObject({ ringing: 2, correspondant: 'SERVICE_CLIENT', targetLabel: 'Service client' });

      const ligne = t.appels[0];
      expect(ligne).toMatchObject({
        caller_id: null,
        caller_customer_id: t.awa.id,
        target_kind: 'CALL_CENTER',
        order_id: t.cmd.id,
        status: CallStatus.RINGING,
      });
      expect([...ligne.rung_user_ids].sort()).toEqual([t.fatou.id, t.yao.id].sort());

      const sonnerie = t.recus(`user_${t.fatou.id}`, 'call:incoming')[0].data;
      expect(sonnerie).toMatchObject({
        callId: ligne.id,
        callerId: t.awa.id,
        callerName: 'Awa Koné',
        callerType: 'CUSTOMER',
        targetKind: 'CALL_CENTER',
        client: {
          id: t.awa.id,
          nom: 'Awa Koné',
          telephone: '+2250707070707',
          commande_id: t.cmd.id,
          commande_reference: 'ORD-261126-00042',
        },
      });
      expect(t.recus(`user_${t.admin.id}`)).toHaveLength(0);

      // Rattrapage à la connexion du back-office : même appelant client.
      const enAttente = await t.calls.listRingingForMe(t.yao);
      expect(enAttente[0]).toMatchObject({ callerType: 'CUSTOMER', callerId: t.awa.id, client: sonnerie.client });

      const reponse = await t.calls.answer(ligne.id, t.fatou);
      expect(reponse.taken).toBe(false);
      expect(t.appels[0]).toMatchObject({ status: CallStatus.ONGOING, answered_by_id: t.fatou.id });
      // Le client apprend que ça a décroché, sans le nom de l'agent.
      expect(t.recus(`customer_${t.awa.id}`, 'call:accepted')).toEqual([
        expect.objectContaining({ data: { callId: ligne.id } }),
      ]);
      expect(t.recus(`user_${t.yao.id}`, 'call:taken')).toHaveLength(1);

      // L'agent retrouve son appel après un rechargement, avec le client.
      const actif = await t.calls.getActiveForMe(t.fatou);
      expect(actif).toMatchObject({ callId: ligne.id, peerLabel: 'Awa Koné', client: sonnerie.client });

      // L'agent raccroche : le client est prévenu.
      await t.calls.hangup(ligne.id, t.fatou);
      expect(t.appels[0].status).toBe(CallStatus.ENDED);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual({ callId: ligne.id, reason: 'hangup' });
    });

    it('sans commande donnée, l’agent voit la commande récente du client', async () => {
      const t = scene();
      await t.appelsClient.appeler(clientConnecte(t.awa), {});
      expect(t.appels[0].order_id).toBe(t.cmd.id);
    });

    it('la commande d’un autre client est ignorée', async () => {
      const t = scene();
      await t.appelsClient.appeler(clientConnecte(t.moussa), { order_id: t.cmd.id });
      // Repli sur SA commande récente, jamais celle d'Awa.
      expect(t.appels[0].order_id).toBe(t.cmdMoussa.id);
    });

    it('le client raccroche avant la réponse : les agents arrêtent de sonner', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      const fin = await t.appelsClient.raccrocher(clientConnecte(t.awa), res.call.id);
      expect(fin).toEqual({ status: CallStatus.CANCELLED });
      expect(t.recus(`user_${t.fatou.id}`, 'call:cancelled')).toHaveLength(1);
      expect(t.recus(`user_${t.yao.id}`, 'call:cancelled')).toHaveLength(1);
      expect(t.lunion.deleteRoom).toHaveBeenCalledWith('salle-1');
    });

    it('le client raccroche en ligne : l’agent est prévenu, pas le client', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      await t.calls.answer(res.call.id, t.yao);
      await t.appelsClient.raccrocher(clientConnecte(t.awa), res.call.id);
      expect(t.appels[0].status).toBe(CallStatus.ENDED);
      expect(t.recus(`user_${t.yao.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'hangup' });
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')).toHaveLength(0);
    });

    it('personne ne décroche en 45 s : appel manqué, le client entend « pas de réponse »', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS + 10);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'no-answer' });
      expect(t.recus(`user_${t.fatou.id}`, 'call:cancelled')).toHaveLength(1);
    });

    it('tous les agents refusent : le client est prévenu', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      await t.calls.reject(res.call.id, t.fatou);
      await t.calls.reject(res.call.id, t.yao);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'no-answer' });
    });

    it('un seul appel à la fois : le second est refusé avec l’appel en cours', async () => {
      const t = scene();
      const premier = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), {}));
      expect(r.statut).toBe(409);
      expect(r.corps).toMatchObject({ code: 'APPEL_EN_COURS', callId: premier.call.id });
    });

    it('appels à répétition : le septième en dix minutes est refusé avec le numéro', async () => {
      const t = scene();
      for (let i = 0; i < 6; i++) {
        const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
        await t.appelsClient.raccrocher(clientConnecte(t.awa), res.call.id);
      }
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), {}));
      expect(r.statut).toBe(429);
      expect(r.corps).toMatchObject({ code: 'TROP_D_APPELS', telephone: '+2252721712130' });
      // Dix minutes plus tard, il peut rappeler.
      jest.setSystemTime(new Date(MAINTENANT.getTime() + 11 * 60_000));
      await expect(t.appelsClient.appeler(clientConnecte(t.awa), {})).resolves.toMatchObject({ ringing: 2 });
    });

    it('personne au service client : refus avec le numéro à appeler', async () => {
      const awa = client();
      const t = monterAppels({ personnel: [], clients: [awa] });
      const r = await refus(t.appelsClient.appeler(clientConnecte(awa), {}));
      expect(r.statut).toBe(503);
      expect(r.corps).toMatchObject({ code: 'AUCUN_AGENT', telephone: '+2252721712130' });
    });

    it('réglage coupé : appeler est refusé avec le numéro, raccrocher reste possible', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      t.reglages[CALLS_CLIENTS_ACTIF_KEY] = '0';
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.moussa), {}));
      expect(r.statut).toBe(403);
      expect(r.corps).toMatchObject({ code: 'APPELS_CLIENTS_DESACTIVES', telephone: '+2252721712130' });
      await expect(t.appelsClient.raccrocher(clientConnecte(t.awa), res.call.id)).resolves.toEqual({
        status: CallStatus.CANCELLED,
      });
    });

    it('Lunion muet : refus avec le numéro, aucun appel créé', async () => {
      const t = scene();
      t.lunion.createRoom.mockRejectedValueOnce(new Error('503'));
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), {}));
      expect(r.statut).toBe(503);
      expect(r.corps).toMatchObject({ code: 'APPELS_INDISPONIBLES', telephone: '+2252721712130' });
      expect(t.appels).toHaveLength(0);
    });
  });

  // ============================================================
  // LE CLIENT APPELLE LE LIVREUR DE SA COMMANDE
  // ============================================================

  describe('le client appelle le livreur de sa commande', () => {
    it('l’appli du livreur sonne avec le prénom du client et la commande, jamais son numéro', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id });

      expect(res).toMatchObject({ ringing: 1, correspondant: 'LIVREUR', targetLabel: 'Votre livreur' });
      const ligne = t.appels[0];
      expect(ligne).toMatchObject({
        caller_customer_id: t.awa.id,
        target_kind: 'DELIVERER',
        target_deliverer_id: t.koffi.id,
        course_id: t.crs.id,
        order_id: t.cmd.id,
      });

      const sonnerie = t.recus(`deliverer_${t.koffi.id}`, 'call:incoming')[0].data;
      expect(sonnerie).toMatchObject({
        callId: ligne.id,
        callerName: 'Awa',
        callerLabel: 'Client',
        appelant: 'CLIENT',
        order_reference: 'ORD-261126-00042',
      });
      expect(JSON.stringify(sonnerie)).not.toContain('0707070707');
      expect(t.push.notifyAppelEntrant).toHaveBeenCalledWith({ delivererId: t.koffi.id, callId: ligne.id, deClient: true });
      // Aucun membre du personnel ne sonne.
      expect(t.recus(`user_${t.fatou.id}`)).toHaveLength(0);

      // Reprise dans l'appli du livreur : « Client », son prénom, la commande.
      const vuDuLivreur = await t.appelsLivreur.monAppel(connecte(t.koffi));
      expect(vuDuLivreur.call).toMatchObject({
        callId: ligne.id,
        phase: 'ringing',
        peerLabel: 'Client',
        appelant: 'CLIENT',
        agentName: 'Awa',
        order_reference: 'ORD-261126-00042',
      });

      // Le livreur décroche : le client est mis en ligne.
      const reponse = await t.appelsLivreur.decrocher(connecte(t.koffi), ligne.id);
      expect(reponse.taken).toBe(false);
      expect(t.appels[0].status).toBe(CallStatus.ONGOING);
      expect(t.recus(`customer_${t.awa.id}`, 'call:accepted')).toHaveLength(1);

      // Le livreur raccroche : le client est prévenu.
      await t.appelsLivreur.raccrocher(connecte(t.koffi), ligne.id);
      expect(t.appels[0].status).toBe(CallStatus.ENDED);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual({ callId: ligne.id, reason: 'hangup' });
    });

    it('le livreur refuse : le client l’apprend', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id });
      await t.appelsLivreur.refuser(connecte(t.koffi), res.call.id);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'rejected' });
    });

    it('le livreur ne décroche pas en 45 s : manqué des deux côtés', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id });
      await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS + 10);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      const fin = { callId: res.call.id, reason: 'no-answer' };
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual(fin);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended')[0].data).toEqual(fin);
    });

    it('le client annule avant la réponse : l’appli du livreur arrête de sonner', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id });
      await t.appelsClient.raccrocher(clientConnecte(t.awa), res.call.id);
      expect(t.appels[0].status).toBe(CallStatus.CANCELLED);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'cancelled' });
    });

    it('refusé pour la commande d’un autre client', async () => {
      const t = scene();
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.moussa), { cible: 'LIVREUR', order_id: t.cmd.id }));
      expect(r.statut).toBe(409);
      expect(r.corps).toMatchObject({ code: 'LIVREUR_INJOIGNABLE' });
      expect(t.appels).toHaveLength(0);
      expect(t.recus(`deliverer_${t.koffi.id}`)).toHaveLength(0);
    });

    it('refusé pour une commande déjà livrée', async () => {
      const t = scene();
      const r = await refus(
        t.appelsClient.appeler(clientConnecte(t.moussa), { cible: 'LIVREUR', order_id: t.cmdMoussa.id }),
      );
      expect(r.corps).toMatchObject({ code: 'LIVREUR_INJOIGNABLE' });
    });

    it('refusé tant qu’aucun livreur n’a pris la course', async () => {
      const t = scene();
      t.crs.deliverer_id = null;
      t.crs.statut = CourseStatut.PENDING_ASSIGNMENT;
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id }));
      expect(r.corps).toMatchObject({ code: 'LIVREUR_INJOIGNABLE' });
    });

    it('sans commande : requête refusée', async () => {
      const t = scene();
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR' }));
      expect(r.statut).toBe(400);
    });

    it('livreur déjà en ligne : « Réessayez dans un instant »', async () => {
      const t = scene();
      await t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {});
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id }));
      expect(r.statut).toBe(409);
      expect(r.corps).toMatchObject({ code: 'LIVREUR_OCCUPE' });
    });

    it('appels des livreurs coupés : le livreur n’est pas joignable dans l’appli', async () => {
      const t = scene({ [CALLS_LIVREURS_ACTIF_KEY]: '0' });
      const r = await refus(t.appelsClient.appeler(clientConnecte(t.awa), { cible: 'LIVREUR', order_id: t.cmd.id }));
      expect(r.corps).toMatchObject({ code: 'LIVREUR_INJOIGNABLE' });
    });
  });

  // ============================================================
  // LE SERVICE CLIENT APPELLE UN CLIENT
  // ============================================================

  describe('le service client appelle un client', () => {
    const cible = (t: ReturnType<typeof scene>) => ({
      targetKind: 'CUSTOMER' as const,
      customer_id: t.awa.id,
      order_id: t.cmd.id,
    });

    it('l’appli du client sonne, avec une notification ; il décroche et l’agent l’apprend', async () => {
      const t = scene();
      const res = await t.appelsClient.appelerClient(t.fatou, cible(t));

      expect(res).toMatchObject({ ringing: 1, online: 1, targetLabel: 'Awa Koné' });
      expect(res.client).toMatchObject({ nom: 'Awa Koné', commande_reference: 'ORD-261126-00042' });
      expect(res.access.identity).toBe('user-' + t.fatou.id);
      const ligne = t.appels[0];
      expect(ligne).toMatchObject({
        caller_id: t.fatou.id,
        target_kind: 'CUSTOMER',
        target_customer_id: t.awa.id,
        order_id: t.cmd.id,
      });

      const sonnerie = t.recus(`customer_${t.awa.id}`, 'call:incoming')[0].data;
      expect(sonnerie).toMatchObject({
        callId: ligne.id,
        callerLabel: 'Service client',
        correspondant: 'SERVICE_CLIENT',
        order_reference: 'ORD-261126-00042',
      });
      // Le client ne voit jamais le nom de l'agent.
      expect(JSON.stringify(sonnerie)).not.toContain('Fatou');
      expect(t.expoPush.sendPushNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: ['ExponentPushToken[awa]'],
          data: { type: 'appel_entrant', callId: ligne.id },
          // Téléphone verrouillé (27/11) : canal d'appels, sonnerie longue,
          // bouton « Répondre », et plus rien après la sonnerie.
          channelId: 'appels_v1',
          sound: 'sonnerie_appel.wav',
          categoryId: 'appel_entrant',
          priority: 'high',
          ttl: 45,
        }),
      );

      // Reprise dans l'appli : ça sonne, pas de jeton tant qu'il n'a pas décroché.
      const vuDuClient = await t.appelsClient.monAppel(clientConnecte(t.awa), true);
      expect(vuDuClient).toMatchObject({
        actif: true,
        call: { callId: ligne.id, phase: 'ringing', direction: 'incoming', correspondant: 'SERVICE_CLIENT' },
        access: null,
      });

      const reponse = await t.appelsClient.decrocher(clientConnecte(t.awa), ligne.id);
      expect(reponse).toMatchObject({ taken: false, access: { identity: 'client-' + t.awa.id } });
      expect(t.appels[0].status).toBe(CallStatus.ONGOING);
      expect(t.recus(`user_${t.fatou.id}`, 'call:accepted')[0].data).toMatchObject({
        callId: ligne.id,
        answeredByName: 'Awa Koné',
      });

      // Le client raccroche : l'agent est prévenu.
      await t.appelsClient.raccrocher(clientConnecte(t.awa), ligne.id);
      expect(t.appels[0].status).toBe(CallStatus.ENDED);
      expect(t.recus(`user_${t.fatou.id}`, 'call:ended')[0].data).toEqual({ callId: ligne.id, reason: 'hangup' });
    });

    it('le client refuse : appel manqué, l’agent l’apprend', async () => {
      const t = scene();
      const res = await t.appelsClient.appelerClient(t.fatou, cible(t));
      await t.appelsClient.refuser(clientConnecte(t.awa), res.call.id);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`user_${t.fatou.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'rejected' });
    });

    it('l’agent annule avant la réponse : l’appli du client arrête de sonner', async () => {
      const t = scene();
      const res = await t.appelsClient.appelerClient(t.fatou, cible(t));
      await t.calls.hangup(res.call.id, t.fatou);
      expect(t.appels[0].status).toBe(CallStatus.CANCELLED);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual({ callId: res.call.id, reason: 'cancelled' });
    });

    it('le client ne décroche pas en 45 s : manqué des deux côtés', async () => {
      const t = scene();
      const res = await t.appelsClient.appelerClient(t.fatou, cible(t));
      await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS + 10);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      const fin = { callId: res.call.id, reason: 'no-answer' };
      expect(t.recus(`user_${t.fatou.id}`, 'call:ended')[0].data).toEqual(fin);
      expect(t.recus(`customer_${t.awa.id}`, 'call:ended')[0].data).toEqual(fin);
    });

    it('appli du client pas à jour : refus avec son numéro, rien ne sonne', async () => {
      const t = scene({}, { appliPrete: false });
      const r = await refus(t.appelsClient.appelerClient(t.fatou, cible(t)));
      expect(r.statut).toBe(409);
      expect(r.corps).toMatchObject({ code: 'CLIENT_SANS_APPLI', telephone: '+2250707070707' });
      expect(t.appels).toHaveLength(0);
      expect(t.recus(`customer_${t.awa.id}`)).toHaveLength(0);
      expect(t.expoPush.sendPushNotifications).not.toHaveBeenCalled();
    });

    it('l’appli qui s’ouvre avec les appels rend le client joignable, une écriture par jour au plus', async () => {
      const t = scene({}, { appliPrete: false });
      await t.appelsClient.monAppel(clientConnecte(t.awa), false);
      expect(t.awa.appels_appli_at).toBeNull();
      await t.appelsClient.monAppel(clientConnecte(t.awa), true);
      expect(t.awa.appels_appli_at).toEqual(MAINTENANT);
      expect(t.prisma.customer.updateMany).toHaveBeenCalledTimes(1);
      await t.appelsClient.monAppel(clientConnecte(t.awa), true);
      expect(t.prisma.customer.updateMany).toHaveBeenCalledTimes(1);
      await expect(t.appelsClient.appelerClient(t.fatou, cible(t))).resolves.toMatchObject({ ringing: 1 });
    });

    it('seuls l’admin et le service client appellent un client', async () => {
      const t = scene();
      const r = await refus(t.appelsClient.appelerClient(t.marketing, cible(t)));
      expect(r.statut).toBe(403);
      await expect(t.appelsClient.appelerClient(t.admin, cible(t))).resolves.toMatchObject({ ringing: 1 });
    });

    it('client déjà en appel : refus', async () => {
      const t = scene();
      await t.appelsClient.appeler(clientConnecte(t.awa), {});
      const r = await refus(t.appelsClient.appelerClient(t.fatou, cible(t)));
      expect(r.statut).toBe(409);
      expect(r.corps).toMatchObject({ code: 'APPEL_EN_COURS' });
    });

    it('la commande d’un autre client n’est pas rattachée à l’appel', async () => {
      const t = scene();
      await t.appelsClient.appelerClient(t.fatou, { ...cible(t), order_id: t.cmdMoussa.id });
      expect(t.appels[0].order_id).toBeNull();
    });

    it('réglage coupé : refus', async () => {
      const t = scene({ [CALLS_CLIENTS_ACTIF_KEY]: '0' });
      const r = await refus(t.appelsClient.appelerClient(t.fatou, cible(t)));
      expect(r.statut).toBe(403);
      expect(r.corps).toMatchObject({ code: 'APPELS_CLIENTS_DESACTIVES' });
      await expect(t.appelsClient.monAppel(clientConnecte(t.awa), true)).resolves.toMatchObject({
        actif: false,
        telephone: '+2252721712130',
      });
    });
  });

  // ============================================================
  // CLOISONNEMENT
  // ============================================================

  describe('un client n’agit que sur ses appels', () => {
    it('un autre client ne peut ni décrocher, ni refuser, ni raccrocher', async () => {
      const t = scene();
      const res = await t.appelsClient.appelerClient(t.fatou, {
        targetKind: 'CUSTOMER',
        customer_id: t.awa.id,
      });
      const intrus = clientConnecte(t.moussa);
      expect((await refus(t.appelsClient.decrocher(intrus, res.call.id))).statut).toBe(403);
      expect((await refus(t.appelsClient.refuser(intrus, res.call.id))).statut).toBe(403);
      expect((await refus(t.appelsClient.raccrocher(intrus, res.call.id))).statut).toBe(403);
      expect(t.appels[0].status).toBe(CallStatus.RINGING);
    });

    it('un client ne décroche pas l’appel qu’il a lui-même passé', async () => {
      const t = scene();
      const res = await t.appelsClient.appeler(clientConnecte(t.awa), {});
      expect((await refus(t.appelsClient.decrocher(clientConnecte(t.awa), res.call.id))).statut).toBe(403);
    });

    it('décrocher trop tard : l’appel annulé n’est pas repris', async () => {
      const t = scene();
      const res = await t.appelsClient.appelerClient(t.fatou, { targetKind: 'CUSTOMER', customer_id: t.awa.id });
      await t.calls.hangup(res.call.id, t.fatou);
      await expect(t.appelsClient.decrocher(clientConnecte(t.awa), res.call.id)).resolves.toEqual({
        taken: true,
        status: CallStatus.CANCELLED,
      });
    });
  });
});
