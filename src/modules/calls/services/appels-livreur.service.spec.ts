import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { CallStatus, CourseStatut, UserRole, UserType } from '@prisma/client';

import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { CALLS_LIVREURS_ACTIF_KEY, SONNERIE_LIVREUR_MS, TTL_JETON_LIVREUR_S } from '../constants/calls.constants';
import { connecte, course, livreur, membre, monterAppels } from './base-appels.simulee-spec';

/**
 * Appels dans l'appli avec les livreurs (demande du 24/10) : le livreur
 * appelle le service client, le service client appelle le livreur. Base,
 * Lunion Meet et passerelle simulés (base-appels.simulee-spec.ts).
 */

/** Code machine porté par le corps d'une erreur HTTP. */
async function codeDuRefus(promesse: Promise<unknown>): Promise<{ statut: number; corps: any }> {
  try {
    await promesse;
  } catch (e) {
    if (e instanceof HttpException) return { statut: e.getStatus(), corps: e.getResponse() };
    throw e;
  }
  throw new Error('refus attendu');
}

describe('Appels avec les livreurs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-24T18:00:00Z'));
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function scene(reglages: Record<string, string> = {}) {
    const awa = membre({ fullname: 'Awa Koné' });
    const yao = membre({ fullname: 'Yao Brou' });
    const admin = membre({ fullname: 'Admin', role: UserRole.ADMIN });
    const marketing = membre({ fullname: 'Marketing', role: UserRole.MARKETING });
    const caissiere = membre({
      fullname: 'Caissière',
      type: UserType.RESTAURANT,
      role: UserRole.CAISSIER,
      restaurant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const koffi = livreur();
    const ali = livreur({ first_name: 'Ali', last_name: 'Traoré', phone: '+2250505050505' });
    const crs = course({ deliverer_id: koffi.id, reference: 'CRS-A1', statut: CourseStatut.IN_DELIVERY });
    const t = monterAppels({
      personnel: [awa, yao, admin, marketing, caissiere],
      livreurs: [koffi, ali],
      courses: [crs],
      reglages,
    });
    return { ...t, awa, yao, admin, marketing, caissiere, koffi, ali, crs };
  }

  // ============================================================
  // LE LIVREUR APPELLE LE SERVICE CLIENT
  // ============================================================

  describe('le livreur appelle le service client', () => {
    it('fait sonner le centre d’appels avec qui appelle, et le premier agent qui décroche gagne', async () => {
      const t = scene();
      const res = await t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {});

      // Jeton de participant de 30 min, jamais la clé du service.
      expect(res.access).toEqual({
        room: 'salle-1',
        token: 'jeton:salle-1:livreur-' + t.koffi.id,
        url: 'wss://sfu.lunion.test',
        identity: 'livreur-' + t.koffi.id,
      });
      expect(t.lunion.createToken).toHaveBeenCalledWith('salle-1', 'livreur-' + t.koffi.id, 'Koffi Kouassi', TTL_JETON_LIVREUR_S);
      expect(res).toMatchObject({ ringing: 2, online: 2, targetLabel: 'Service client' });
      expect(res.call).toMatchObject({ status: CallStatus.RINGING, course_id: t.crs.id, order_id: null });

      const ligne = t.appels[0];
      expect(ligne).toMatchObject({
        caller_id: null,
        caller_type: null,
        caller_deliverer_id: t.koffi.id,
        target_kind: 'CALL_CENTER',
        course_id: t.crs.id,
      });
      // Seul le rôle CALL_CENTER sonne (config de routage par défaut).
      expect([...ligne.rung_user_ids].sort()).toEqual([t.awa.id, t.yao.id].sort());

      const sonnerie = t.recus(`user_${t.awa.id}`, 'call:incoming')[0].data;
      expect(sonnerie).toMatchObject({
        callId: ligne.id,
        callerId: t.koffi.id,
        callerName: 'Koffi Kouassi',
        callerType: 'DELIVERER',
        targetKind: 'CALL_CENTER',
        livreur: {
          id: t.koffi.id,
          nom: 'Koffi Kouassi',
          telephone: '+2250701020304',
          restaurant: 'Angré',
          course_reference: 'CRS-A1',
        },
      });
      expect(t.recus(`user_${t.admin.id}`)).toHaveLength(0);

      // Rattrapage à la connexion du backoffice : même appelant livreur.
      const enAttente = await t.calls.listRingingForMe(t.yao);
      expect(enAttente[0]).toMatchObject({ callerType: 'DELIVERER', callerId: t.koffi.id, livreur: sonnerie.livreur });

      // Deux agents décrochent au même instant : un seul gagne.
      const [a, b] = await Promise.all([t.calls.answer(ligne.id, t.awa), t.calls.answer(ligne.id, t.yao)]);
      expect([a.taken, b.taken].sort()).toEqual([false, true]);
      const gagnant = a.taken ? t.yao : t.awa;
      const perdant = a.taken ? t.awa : t.yao;
      expect(t.appels[0]).toMatchObject({ status: CallStatus.ONGOING, answered_by_id: gagnant.id });

      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:accepted')).toEqual([
        expect.objectContaining({
          data: { callId: ligne.id, answeredById: gagnant.id, answeredByName: gagnant.fullname },
        }),
      ]);
      expect(t.recus(`user_${perdant.id}`, 'call:taken')).toHaveLength(1);

      // Reprise dans l'appli : en ligne, jeton frais.
      const repris = await t.appelsLivreur.monAppel(connecte(t.koffi));
      expect(repris).toMatchObject({
        actif: true,
        call: { callId: ligne.id, direction: 'outgoing', phase: 'connected', peerLabel: 'Service client', agentName: gagnant.fullname },
        access: { identity: 'livreur-' + t.koffi.id },
      });

      // Le livreur raccroche : seul l'agent en ligne est prévenu.
      expect(await t.appelsLivreur.raccrocher(connecte(t.koffi), ligne.id)).toEqual({ status: CallStatus.ENDED });
      expect(t.recus(`user_${gagnant.id}`, 'call:ended').map((e) => e.data)).toEqual([{ callId: ligne.id, reason: 'hangup' }]);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended')).toHaveLength(0);

      // La minuterie de sonnerie ne touche plus un appel décroché.
      await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS + 1000);
      expect(t.appels[0].status).toBe(CallStatus.ENDED);

      // Journal d'audit : les actions du livreur y sont écrites.
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actor_role: 'LIVREUR', module: 'calls', entity_id: ligne.id, action: 'CREATE' }),
      );

      // Historique du personnel : l'appelant livreur, sa course.
      const historique = await t.calls.history(gagnant);
      expect(historique[0]).toMatchObject({
        caller_type: 'DELIVERER',
        caller_deliverer: { id: t.koffi.id, first_name: 'Koffi', restaurant: { name: 'Angré' } },
        course: { reference: 'CRS-A1' },
      });
    });

    it('sans réponse au bout de 45 s : manqué, le livreur entend « pas de réponse », les agents arrêtent de sonner', async () => {
      const t = scene();
      const res = await t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {});
      await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS);

      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended').map((e) => e.data)).toEqual([
        { callId: res.call.id, reason: 'no-answer' },
      ]);
      expect(t.recus(`user_${t.awa.id}`, 'call:cancelled')).toHaveLength(1);
      expect(t.lunion.deleteRoom).toHaveBeenCalledWith('salle-1');
    });

    it('le dernier agent qui refuse rend l’appel manqué et prévient le livreur', async () => {
      const t = scene();
      const res = await t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {});
      await t.calls.reject(res.call.id, t.awa);
      expect(t.recus(`deliverer_${t.koffi.id}`)).toHaveLength(0); // « call:rejected » reste au personnel
      await t.calls.reject(res.call.id, t.yao);
      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended').map((e) => e.data)).toEqual([
        { callId: res.call.id, reason: 'no-answer' },
      ]);
    });

    it('le livreur annule avant la réponse : les agents arrêtent de sonner', async () => {
      const t = scene();
      const res = await t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {});
      expect(await t.appelsLivreur.raccrocher(connecte(t.koffi), res.call.id)).toEqual({ status: CallStatus.CANCELLED });
      expect(t.recus(`user_${t.awa.id}`, 'call:cancelled')).toHaveLength(1);
      expect(t.recus(`user_${t.yao.id}`, 'call:cancelled')).toHaveLength(1);
    });

    it('un seul appel à la fois ; la course donnée doit être la sienne', async () => {
      const t = scene();
      const autre = course({ deliverer_id: t.ali.id, reference: 'CRS-ALI' });
      // Course d'un autre livreur : ignorée, on garde la sienne en cours.
      const res = await t.appelsLivreur.appelerServiceClient(connecte(t.koffi), { course_id: autre.id });
      expect(t.appels[0].course_id).toBe(t.crs.id);

      const refus = await codeDuRefus(t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {}));
      expect(refus.statut).toBe(409);
      expect(refus.corps).toMatchObject({ code: 'APPEL_EN_COURS', callId: res.call.id });
    });

    it('personne au service client : 503 AUCUN_AGENT avec le numéro, aucune salle ouverte', async () => {
      const koffi = livreur();
      const t = monterAppels({ livreurs: [koffi] });
      const refus = await codeDuRefus(t.appelsLivreur.appelerServiceClient(connecte(koffi), {}));
      expect(refus.statut).toBe(503);
      expect(refus.corps).toMatchObject({ code: 'AUCUN_AGENT', telephone: '+2252721712130' });
      expect(t.lunion.createRoom).not.toHaveBeenCalled();
    });

    it('Lunion ne répond pas : 503 APPELS_INDISPONIBLES, l’appli passe au téléphone', async () => {
      const t = scene();
      t.lunion.createRoom.mockRejectedValueOnce(new Error('injoignable'));
      const refus = await codeDuRefus(t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {}));
      expect(refus.statut).toBe(503);
      expect(refus.corps).toMatchObject({ code: 'APPELS_INDISPONIBLES', telephone: '+2252721712130' });
      expect(t.appels).toHaveLength(0);
    });
  });

  // ============================================================
  // LE SERVICE CLIENT APPELLE LE LIVREUR
  // ============================================================

  describe('le service client appelle le livreur', () => {
    async function appeler(t: ReturnType<typeof scene>) {
      const res = await t.appelsLivreur.appelerLivreur(t.awa, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id });
      return { res, callId: res.call.id };
    }

    it('réponse : l’appli sonne, le livreur décroche, l’agent est prévenu, puis raccroche', async () => {
      const t = scene();
      const { res, callId } = await appeler(t);

      expect(res).toMatchObject({
        ringing: 1,
        online: 1,
        targetLabel: 'Koffi Kouassi',
        livreur: { id: t.koffi.id, nom: 'Koffi Kouassi', restaurant: 'Angré', course_reference: 'CRS-A1' },
        access: { identity: 'user-' + t.awa.id },
      });
      expect(t.appels[0]).toMatchObject({
        caller_id: t.awa.id,
        caller_type: UserType.BACKOFFICE,
        target_kind: 'DELIVERER',
        target_deliverer_id: t.koffi.id,
        ringing_user_ids: [],
        course_id: t.crs.id,
      });
      const sonnerie = t.recus(`deliverer_${t.koffi.id}`, 'call:incoming')[0].data;
      expect(sonnerie).toMatchObject({ callId, callerName: 'Awa Koné', callerLabel: 'Service client' });
      expect(sonnerie.expiresAt.getTime() - sonnerie.startedAt.getTime()).toBe(SONNERIE_LIVREUR_MS);
      expect(t.push.notifyAppelEntrant).toHaveBeenCalledWith({ delivererId: t.koffi.id, callId });

      // Appli relancée pendant la sonnerie : l'appel est là, sans jeton tant qu'il n'a pas décroché.
      expect(await t.appelsLivreur.monAppel(connecte(t.koffi))).toMatchObject({
        actif: true,
        call: { callId, direction: 'incoming', phase: 'ringing', agentName: 'Awa Koné' },
        access: null,
      });

      const decroche = await t.appelsLivreur.decrocher(connecte(t.koffi), callId);
      expect(decroche).toMatchObject({ taken: false, access: { identity: 'livreur-' + t.koffi.id } });
      expect(t.appels[0].status).toBe(CallStatus.ONGOING);
      expect(t.recus(`user_${t.awa.id}`, 'call:accepted').map((e) => e.data)).toEqual([
        { callId, answeredById: t.koffi.id, answeredByName: 'Koffi Kouassi' },
      ]);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:taken').map((e) => e.data)).toEqual([
        { callId, takenBy: 'Koffi Kouassi' },
      ]);

      // Restauration côté backoffice : le livreur est reconnu.
      expect(await t.calls.getActiveForMe(t.awa)).toMatchObject({
        callId,
        direction: 'outgoing',
        phase: 'connected',
        peerLabel: 'Koffi Kouassi',
        livreur: { course_reference: 'CRS-A1' },
      });

      expect(await t.calls.hangup(callId, t.awa)).toEqual({ status: CallStatus.ENDED });
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended').map((e) => e.data)).toEqual([{ callId, reason: 'hangup' }]);
      expect(t.recus(`user_${t.awa.id}`, 'call:ended')).toHaveLength(0);
    });

    it('refus : appel manqué, l’agent reçoit call:ended « rejected »', async () => {
      const t = scene();
      const { callId } = await appeler(t);
      expect(await t.appelsLivreur.refuser(connecte(t.koffi), callId)).toEqual({ status: CallStatus.MISSED });
      expect(t.recus(`user_${t.awa.id}`, 'call:ended').map((e) => e.data)).toEqual([{ callId, reason: 'rejected' }]);
      // Raccrocher pendant la sonnerie revient à refuser (appel déjà clos ici).
      expect(await t.appelsLivreur.raccrocher(connecte(t.koffi), callId)).toEqual({ status: CallStatus.MISSED });
    });

    it('raccrochage : l’agent annule avant la réponse, puis un appel en ligne que le livreur raccroche', async () => {
      const t = scene();
      const premier = await appeler(t);
      expect(await t.calls.hangup(premier.callId, t.awa)).toEqual({ status: CallStatus.CANCELLED });
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended').map((e) => e.data)).toEqual([
        { callId: premier.callId, reason: 'cancelled' },
      ]);
      // Trop tard pour décrocher : ni jeton, ni changement.
      expect(await t.appelsLivreur.decrocher(connecte(t.koffi), premier.callId)).toEqual({
        taken: true,
        status: CallStatus.CANCELLED,
      });

      const second = await appeler(t);
      await t.appelsLivreur.decrocher(connecte(t.koffi), second.callId);
      expect(await t.appelsLivreur.raccrocher(connecte(t.koffi), second.callId)).toEqual({ status: CallStatus.ENDED });
      expect(t.recus(`user_${t.awa.id}`, 'call:ended').map((e) => e.data)).toEqual([
        { callId: second.callId, reason: 'hangup' },
      ]);
    });

    it('appel manqué : sans réponse au bout de 45 s, les deux côtés reçoivent call:ended « no-answer »', async () => {
      const t = scene();
      const { callId } = await appeler(t);
      await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS - 1000);
      expect(t.appels[0].status).toBe(CallStatus.RINGING);
      await jest.advanceTimersByTimeAsync(1000);

      expect(t.appels[0].status).toBe(CallStatus.MISSED);
      expect(t.recus(`user_${t.awa.id}`, 'call:ended').map((e) => e.data)).toEqual([{ callId, reason: 'no-answer' }]);
      expect(t.recus(`deliverer_${t.koffi.id}`, 'call:ended').map((e) => e.data)).toEqual([{ callId, reason: 'no-answer' }]);
      const tard = await t.appelsLivreur.decrocher(connecte(t.koffi), callId);
      expect(tard).toEqual({ taken: true, status: CallStatus.MISSED });
      expect(t.lunion.createToken).not.toHaveBeenCalledWith(expect.anything(), 'livreur-' + t.koffi.id, expect.anything(), expect.anything());
    });

    it('seuls le service client et l’admin appellent un livreur ; livreur déjà en ligne : 409', async () => {
      const t = scene();
      await expect(
        t.appelsLivreur.appelerLivreur(t.marketing, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        t.appelsLivreur.appelerLivreur(t.caissiere, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await t.appelsLivreur.appelerLivreur(t.admin, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id });
      await expect(
        t.appelsLivreur.appelerLivreur(t.awa, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id }),
      ).rejects.toBeInstanceOf(ConflictException);
      // Un autre agent ne décroche pas à la place du livreur.
      await expect(t.calls.answer(t.appels[0].id, t.yao)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ============================================================
  // UN LIVREUR N'AGIT QUE SUR SES APPELS
  // ============================================================

  it('un livreur ne décroche, ne refuse, ne raccroche ni ne reprend l’appel d’un autre livreur', async () => {
    // Le service client appelle Koffi…
    const t = scene();
    const versKoffi = await t.appelsLivreur.appelerLivreur(t.awa, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id });
    // … et, ailleurs, Koffi appelle le service client.
    const t2 = scene();
    const sortant = await t2.appelsLivreur.appelerServiceClient(connecte(t2.koffi), {});

    const ali = connecte(t.ali);
    await expect(t.appelsLivreur.decrocher(ali, versKoffi.call.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.appelsLivreur.refuser(ali, versKoffi.call.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.appelsLivreur.raccrocher(ali, versKoffi.call.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.appels[0].status).toBe(CallStatus.RINGING);
    expect(await t.appelsLivreur.monAppel(ali)).toMatchObject({ call: null, access: null });

    const ali2 = connecte(t2.ali);
    await expect(t2.appelsLivreur.raccrocher(ali2, sortant.call.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t2.appelsLivreur.decrocher(ali2, sortant.call.id)).rejects.toBeInstanceOf(ForbiddenException);
    // Même Koffi ne « décroche » pas son propre appel sortant : il n'en est pas l'appelé.
    await expect(t2.appelsLivreur.decrocher(connecte(t2.koffi), sortant.call.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t2.appels[0].status).toBe(CallStatus.RINGING);

    // Aucun jeton n'est jamais sorti pour Ali.
    const identites = [...t.lunion.createToken.mock.calls, ...t2.lunion.createToken.mock.calls].map((c) => c[1]);
    expect(identites).not.toContain('livreur-' + t.ali.id);
  });

  // ============================================================
  // RÉGLAGE calls.livreurs_actif
  // ============================================================

  describe('réglage calls.livreurs_actif à 0', () => {
    it('les routes livreur répondent proprement que c’est désactivé', async () => {
      const t = scene({ [CALLS_LIVREURS_ACTIF_KEY]: '0' });

      const appel = await codeDuRefus(t.appelsLivreur.appelerServiceClient(connecte(t.koffi), {}));
      expect(appel.statut).toBe(403);
      expect(appel.corps).toMatchObject({ code: 'APPELS_LIVREURS_DESACTIVES', telephone: '+2252721712130' });
      expect(appel.corps.message).toContain('27 21 71 21 30');

      expect(await t.appelsLivreur.monAppel(connecte(t.koffi))).toEqual({
        actif: false,
        telephone: '+2252721712130',
        call: null,
        access: null,
      });

      const personnel = await codeDuRefus(
        t.appelsLivreur.appelerLivreur(t.awa, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id }),
      );
      expect(personnel).toMatchObject({ statut: 403, corps: { code: 'APPELS_LIVREURS_DESACTIVES' } });
      expect(t.lunion.createRoom).not.toHaveBeenCalled();
    });

    it('coupé pendant un appel : décrocher est refusé, refuser et raccrocher restent possibles', async () => {
      const t = scene();
      const versKoffi = await t.appelsLivreur.appelerLivreur(t.awa, { targetKind: 'DELIVERER', deliverer_id: t.koffi.id });
      t.reglages[CALLS_LIVREURS_ACTIF_KEY] = 'off';

      const refus = await codeDuRefus(t.appelsLivreur.decrocher(connecte(t.koffi), versKoffi.call.id));
      expect(refus).toMatchObject({ statut: 403, corps: { code: 'APPELS_LIVREURS_DESACTIVES' } });
      expect(await t.appelsLivreur.raccrocher(connecte(t.koffi), versKoffi.call.id)).toEqual({ status: CallStatus.MISSED });

      // Réglage remis à 1 (ou absent) : de nouveau actif.
      t.reglages[CALLS_LIVREURS_ACTIF_KEY] = '1';
      expect(await t.appelsLivreur.actifs()).toBe(true);
      delete t.reglages[CALLS_LIVREURS_ACTIF_KEY];
      expect(await t.appelsLivreur.actifs()).toBe(true);
    });
  });

  // ============================================================
  // APPELS ENTRE MEMBRES DU PERSONNEL : INCHANGÉS
  // ============================================================

  it('appel d’une caisse vers le centre d’appels : mêmes événements qu’avant, sans champ livreur', async () => {
    const t = scene();
    const res = await t.calls.start(t.caissiere, {});
    expect(res).toMatchObject({ ringing: 2, targetLabel: 'Call Center' });
    const sonnerie = t.recus(`user_${t.awa.id}`, 'call:incoming')[0].data;
    expect(sonnerie).toMatchObject({ callerId: t.caissiere.id, callerType: UserType.RESTAURANT });
    expect(sonnerie).not.toHaveProperty('livreur');
    expect((await t.calls.listRingingForMe(t.awa))[0]).not.toHaveProperty('livreur');

    await t.calls.answer(res.call.id, t.awa);
    expect(t.recus(`user_${t.caissiere.id}`, 'call:accepted')).toHaveLength(1);
    await t.calls.hangup(res.call.id, t.caissiere);
    expect(t.recus(`user_${t.awa.id}`, 'call:ended').map((e) => e.data)).toEqual([{ callId: res.call.id, reason: 'hangup' }]);
    expect(t.evenements.some((e) => e.salle.startsWith('deliverer_'))).toBe(false);

    // Pas de minuterie serveur sur les appels du personnel.
    const deux = await t.calls.start(t.caissiere, {});
    await jest.advanceTimersByTimeAsync(SONNERIE_LIVREUR_MS * 2);
    expect(t.appels.find((a) => a.id === deux.call.id)?.status).toBe(CallStatus.RINGING);
    expect((await t.calls.history(t.awa))[0].caller_type).toBe(UserType.RESTAURANT);
  });

  it('notification « Le service client t’appelle » : type appel_entrant, priorité haute, canal et sonnerie des appels', async () => {
    const prisma = {
      deliverer: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[x]', first_name: 'Koffi', protocole_appli: 4 })) },
    };
    const expoPush = { sendPushNotifications: jest.fn(async () => undefined) };
    const service = new DelivererPushService(prisma as never, expoPush as never);
    jest.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    service.notifyAppelEntrant({ delivererId: 'd1', callId: 'c1' });
    await jest.advanceTimersByTimeAsync(0);
    expect(expoPush.sendPushNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Le service client t'appelle",
        priority: 'high',
        data: { type: 'appel_entrant', callId: 'c1' },
        // Pas le canal par défaut (un « ding » court) : le canal des appels de l'appli 1.1.0.
        channelId: 'appels_v1',
        sound: 'sonnerie_appel.wav',
      }),
    );
  });
});
