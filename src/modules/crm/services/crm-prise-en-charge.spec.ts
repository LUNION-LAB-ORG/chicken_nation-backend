import { CrmCallOutcome, CrmEventType, CrmStatus, User } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { DEFAULT_MAX_ATTEMPTS, STATUTS_OUVERTS, statutApresAppel } from '../crm.rules';
import { CrmAccessService } from './crm-access.service';
import { CrmContactService } from './crm-contact.service';
import { CrmEventsService } from './crm-events.service';

describe('annuaire : statut NON_DEMARCHE', () => {
  /**
   * L'invariant qui protège les agents : une fiche de l'annuaire ne doit entrer
   * dans aucun portefeuille ni dans aucune file. Tout en dépend.
   */
  it('n’est jamais un statut ouvert', () => {
    expect(STATUTS_OUVERTS).not.toContain(CrmStatus.NON_DEMARCHE);
  });

  /**
   * Et l'invariant qui protège les chiffres : un client qui commande sans qu'on
   * l'appelle ne doit JAMAIS compter comme une conversion du call center.
   */
  it('n’est pas « converti »', () => {
    expect(CrmStatus.NON_DEMARCHE).not.toBe(CrmStatus.CONVERTI);
  });

  const ctx = { dejaJoint: false, tentatives: 1, maxTentatives: DEFAULT_MAX_ATTEMPTS };

  it('qualifier un appel le fait entrer dans l’entonnoir, comme un « à appeler »', () => {
    for (const outcome of Object.values(CrmCallOutcome)) {
      expect([outcome, statutApresAppel(CrmStatus.NON_DEMARCHE, outcome, ctx)]).toEqual([
        outcome,
        statutApresAppel(CrmStatus.A_APPELER, outcome, ctx),
      ]);
    }
  });

  /**
   * Le cas précis qui motivait la règle : sans elle, « pas de réponse » le
   * laissait non démarché avec des tentatives au compteur, c'est-à-dire
   * travaillé mais invisible partout.
   */
  it('ne reste pas « non démarché » après un appel sans réponse', () => {
    const apres = statutApresAppel(CrmStatus.NON_DEMARCHE, CrmCallOutcome.NON_JOINT, ctx);
    expect(apres).toBe(CrmStatus.A_APPELER);
  });

  it('passe injoignable après assez de tentatives, comme les autres', () => {
    const apres = statutApresAppel(CrmStatus.NON_DEMARCHE, CrmCallOutcome.NON_JOINT, {
      ...ctx,
      tentatives: DEFAULT_MAX_ATTEMPTS,
    });
    expect(apres).toBe(CrmStatus.INJOIGNABLE);
  });

  it('l’événement de prise en charge est une ASSIGNATION', () => {
    expect(CrmEventType.ASSIGNATION).toBeDefined();
  });
});

/**
 * Problème 1 du 02/11 : la fiche gardait comme date d'entrée la dernière
 * commande du client, que la réconciliation prenait pour une vente du centre
 * d'appels dans les minutes suivant la prise. La prise fixe désormais la date
 * d'entrée, dans la même écriture que le statut.
 */
describe('prendreEnCharge', () => {
  it('fixe la date d’entrée à la prise, dans la même revendication que le statut', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      crmContact: {
        findFirst: jest.fn().mockResolvedValue({ id: 'x1', status: CrmStatus.NON_DEMARCHE, campaign_id: null }),
        updateMany,
      },
    } as unknown as PrismaService;
    const access = { assertAgent: jest.fn() } as unknown as CrmAccessService;
    const events = { journaliser: jest.fn(), signaler: jest.fn() } as unknown as CrmEventsService;
    const service = new CrmContactService(prisma, access, events);

    const avant = Date.now();
    await service.prendreEnCharge({ id: 'agent-1', fullname: 'Agent' } as User, 'x1');

    const { where, data } = updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 'x1', status: CrmStatus.NON_DEMARCHE });
    expect(data).toMatchObject({ status: CrmStatus.A_APPELER, assigned_to_id: 'agent-1' });
    expect(data.segment_since).toBeInstanceOf(Date);
    expect(data.segment_since.getTime()).toBeGreaterThanOrEqual(avant);
    expect(data.segment_since).toEqual(data.assigned_at);
  });
});
