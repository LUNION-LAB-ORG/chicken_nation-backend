/**
 * Cloche des échéances dépassées (contrat 3.6) : une seule par avis, même à
 * deux serveurs ; l'agent assigné, sinon le call center, plus les
 * administrateurs ; avis tenus, clos ou en incident ignorés.
 */
import { AvisCanal, AvisRessenti, AvisStatut, UserRole } from '@prisma/client';
import { creerBaseAvis } from './avis-prive-base-simulee-spec';
import { AvisPriveNotificationsTemplate } from './avis-prive-notifications.template';
import { AvisPriveRetardTask } from './avis-prive-retard.task';
import { TEXTE_RETARD } from './avis-prive.rules';

const RECU = new Date('2026-11-02T08:42:00.000Z');
const ECHEANCE = new Date('2026-11-03T08:42:00.000Z');
const APRES = new Date('2026-11-03T10:45:00.000Z');

const destinataire = (id: string, role: UserRole) => ({
  id,
  type: 'backoffice_user' as const,
  role,
  name: id,
  in_app_notifications_enabled: true,
});

const enRetard = (id: string, champs: Record<string, unknown> = {}) => ({
  id,
  ressenti: AvisRessenti.PAS_CONTENT,
  canal: AvisCanal.APPLI,
  commentaire: 'Frites froides.',
  telephone: '+2250707000001',
  prenom: 'Awa',
  accord_rappel: true,
  statut: AvisStatut.A_RAPPELER,
  echeance_at: ECHEANCE,
  restaurant: { name: 'Yopougon' },
  created_at: RECU,
  ...champs,
});

function monter(avis: Record<string, unknown>[]) {
  const base = creerBaseAvis({ avis });
  const notifications = {
    sendNotificationToMultiple: jest.fn(async (_t: unknown, ctx: { recipients: { id: string }[] }) =>
      ctx.recipients.map((r) => ({ id: `n-${r.id}` })),
    ),
  };
  const ws = { emitNotification: jest.fn() };
  const destinataires = {
    getUser: jest.fn(async (id: string) => {
      if (id === 'agent-actif') return destinataire('agent-actif', UserRole.CALL_CENTER);
      throw new Error('User not found');
    }),
    getAllUsersByBackofficeAndRole: jest.fn(async (roles: UserRole[]) =>
      roles.includes(UserRole.ADMIN)
        ? [destinataire('admin', UserRole.ADMIN)]
        : [destinataire('cc-1', UserRole.CALL_CENTER), destinataire('cc-2', UserRole.CALL_CENTER)],
    ),
  };
  const tache = () => new AvisPriveRetardTask(base.prisma as never, notifications as never, ws as never, destinataires as never);
  return { base, notifications, destinataires, tache };
}

const destinatairesDe = (appel: unknown[]) =>
  (appel[1] as { recipients: { id: string }[] }).recipients.map((r) => r.id);

describe('AvisPriveRetardTask', () => {
  it('une seule cloche par avis, même avec deux serveurs qui passent en même temps', async () => {
    const { base, notifications, tache } = monter([enRetard('a1'), enRetard('a2')]);
    const [s1, s2] = await Promise.all([tache().passage(APRES), tache().passage(APRES)]);
    expect([...s1, ...s2].sort()).toEqual(['a1', 'a2']);
    expect(notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(2);
    expect(base.avis('a1').alerte_retard_at).toEqual(APRES);
    expect(base.suivis('a1').map((s) => s.note)).toEqual([TEXTE_RETARD]);

    // Passage suivant : rien de neuf.
    await expect(tache().passage(new Date(APRES.getTime() + 5 * 60_000))).resolves.toEqual([]);
    expect(notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(2);
  });

  it('agent assigné actif : lui et les administrateurs ; texte et données de la cloche', async () => {
    const { notifications, tache } = monter([enRetard('a1', { agent_id: 'agent-actif' })]);
    await tache().passage(APRES);
    const appel = notifications.sendNotificationToMultiple.mock.calls[0] as unknown[];
    expect(appel[0]).toBe(AvisPriveNotificationsTemplate.RETARD);
    expect(destinatairesDe(appel)).toEqual(['agent-actif', 'admin']);
    expect((appel[1] as { meta: unknown }).meta).toEqual({ kind: 'avis', avis_id: 'a1' });
    expect((appel[1] as { data: unknown }).data).toEqual({ nom: 'Awa', store: 'Yopougon', echeance: '03/11 à 08:42' });
  });

  it('sans agent, ou agent désactivé : tout le call center, plus les administrateurs', async () => {
    const { notifications, tache } = monter([enRetard('a1'), enRetard('a2', { agent_id: 'agent-parti' })]);
    await tache().passage(APRES);
    for (const appel of notifications.sendNotificationToMultiple.mock.calls) {
      expect(destinatairesDe(appel as unknown[])).toEqual(['cc-1', 'cc-2', 'admin']);
    }
  });

  it('échéance tenue, avis clos, en incident, sans échéance, pas encore échu ou supprimé : ignorés', async () => {
    const { notifications, tache } = monter([
      enRetard('tenu', { statut: AvisStatut.EN_COURS, premier_contact_at: RECU }),
      enRetard('resolu', { statut: AvisStatut.RESOLU }),
      enRetard('classe', { statut: AvisStatut.CLASSE }),
      enRetard('incident', { statut: AvisStatut.INCIDENT_OUVERT }),
      enRetard('nouveau', { statut: AvisStatut.NOUVEAU, echeance_at: null }),
      enRetard('a-venir', { echeance_at: new Date(APRES.getTime() + 60_000) }),
      enRetard('supprime', { entity_status: 'DELETED' }),
      enRetard('injoignable', { statut: AvisStatut.INJOIGNABLE }),
    ]);
    await expect(tache().passage(APRES)).resolves.toEqual(['injoignable']);
    expect(notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(1);
  });

  it('cloche en échec : l’avis reste revendiqué (pas d’alerte en boucle), le passage continue', async () => {
    const { base, notifications, tache } = monter([enRetard('a1'), enRetard('a2')]);
    notifications.sendNotificationToMultiple.mockRejectedValueOnce(new Error('socket coupée'));
    await expect(tache().passage(APRES)).resolves.toEqual(['a1', 'a2']);
    expect(base.avis('a1').alerte_retard_at).toEqual(APRES);
    expect(base.suivis('a2').map((s) => s.note)).toEqual([TEXTE_RETARD]);
  });
});
