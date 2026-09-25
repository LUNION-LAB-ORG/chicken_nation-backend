import { BadRequestException } from '@nestjs/common';
import { CrmCallOutcome as O, CrmSegment, CrmStatus, User } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmAccessService } from './crm-access.service';
import { CrmCallService } from './crm-call.service';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';

const CONTACT = 'contact-1';
const STATUT = 'statut-1';
const RAISON = 'raison-trop-cher';
const agent = { id: 'agent-1' } as User;

/**
 * Faux Prisma : un contact à appeler, un statut de l'issue voulue, et des
 * raisons dont on choisit celles qui sont actives. On regarde ce qui est écrit.
 */
function monter(outcome: O, raisonsActives: string[] = [RAISON]) {
  const ecritContact = jest.fn().mockResolvedValue({ count: 1 });
  const ecritAppel = jest.fn().mockResolvedValue({ id: 'appel-1' });
  const chercheRaison = jest.fn(({ where }: { where: { id: string; is_active?: boolean } }) =>
    Promise.resolve(where.is_active === true && raisonsActives.includes(where.id) ? { id: where.id } : null),
  );
  const tx = {
    crmContact: { updateMany: ecritContact, findUnique: jest.fn() },
    crmCall: { create: ecritAppel },
  };
  const prisma = {
    crmContact: {
      findFirst: jest.fn().mockResolvedValue({
        id: CONTACT,
        status: CrmStatus.A_APPELER,
        segment: CrmSegment.JAMAIS_COMMANDE,
        segment_since: new Date(),
        cycle: 1,
        call_count: 0,
        first_reached_at: null,
        qualified_at: null,
        assigned_to_id: agent.id,
        campaign_id: null,
        campaign: null,
      }),
    },
    crmCallStatus: { findFirst: jest.fn().mockResolvedValue({ id: STATUT, label: 'Statut', outcome }) },
    crmReason: { findFirst: chercheRaison },
    $transaction: (travail: (t: typeof tx) => Promise<unknown>) => travail(tx),
  } as unknown as PrismaService;
  const access = {
    assertPeutTraiter: jest.fn(),
    prendre: jest.fn(),
    conditionAgent: () => ({}),
  } as unknown as CrmAccessService;
  const config = { lireReglages: jest.fn().mockResolvedValue({ max_attempts: 5 }) } as unknown as CrmConfigService;
  const events = { journaliser: jest.fn(), signaler: jest.fn() } as unknown as CrmEventsService;
  const service = new CrmCallService(prisma, access, config, events);
  const donnees = () => ({
    contact: ecritContact.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined,
    appel: ecritAppel.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined,
  });
  return { service, chercheRaison, donnees };
}

describe("CrmCallService.enregistrer : la raison d'un appel", () => {
  it("pas intéressé : la raison va sur l'appel et sur la fiche", async () => {
    const { service, donnees } = monter(O.NON_INTERESSE);
    await service.enregistrer(agent, CONTACT, { call_status_id: STATUT, loss_reason_id: RAISON });
    expect(donnees().appel?.loss_reason_id).toBe(RAISON);
    expect(donnees().contact?.loss_reason_id).toBe(RAISON);
  });

  it('pas intéressé sans raison : refusé', async () => {
    const { service } = monter(O.NON_INTERESSE);
    await expect(service.enregistrer(agent, CONTACT, { call_status_id: STATUT })).rejects.toThrow(
      'Indiquez la raison pour laquelle le client ne commande pas',
    );
  });

  it('à rappeler : la raison facultative est gardée', async () => {
    const { service, donnees } = monter(O.A_RAPPELER);
    await service.enregistrer(agent, CONTACT, { call_status_id: STATUT, loss_reason_id: RAISON });
    expect(donnees().appel?.loss_reason_id).toBe(RAISON);
  });

  it("intéressé avec une raison restée choisie : ignorée, et l'ancienne raison de la fiche est effacée", async () => {
    const { service, chercheRaison, donnees } = monter(O.INTERESSE);
    await service.enregistrer(agent, CONTACT, { call_status_id: STATUT, loss_reason_id: RAISON });
    expect(chercheRaison).not.toHaveBeenCalled();
    expect(donnees().appel?.loss_reason_id).toBeNull();
    expect(donnees().contact?.loss_reason_id).toBeNull();
  });

  it("non joint avec une raison : ignorée, la fiche garde ce qu'elle avait", async () => {
    const { service, donnees } = monter(O.NON_JOINT);
    await service.enregistrer(agent, CONTACT, { call_status_id: STATUT, loss_reason_id: RAISON });
    expect(donnees().appel?.loss_reason_id).toBeNull();
    expect(donnees().contact).not.toHaveProperty('loss_reason_id');
  });

  it('raison désactivée dans les réglages : refusée, rien écrit', async () => {
    const { service, donnees } = monter(O.NON_INTERESSE, []);
    const envoi = service.enregistrer(agent, CONTACT, { call_status_id: STATUT, loss_reason_id: RAISON });
    await expect(envoi).rejects.toBeInstanceOf(BadRequestException);
    await expect(envoi).rejects.toThrow('Raison de non-commande inconnue ou désactivée');
    expect(donnees().appel).toBeUndefined();
    expect(donnees().contact).toBeUndefined();
  });

  it("ancienne file d'acquisition : un refus sans raison passe toujours", async () => {
    const { service, donnees } = monter(O.NON_INTERESSE);
    await service.enregistrer(agent, CONTACT, { call_status_id: STATUT }, { sansRaison: true });
    expect(donnees().appel?.loss_reason_id).toBeNull();
  });
});
