import { CrmEventType, CrmStatus, EntityStatus } from '@prisma/client';
import { conditionDormants, limiteDormants, DEFAULT_DORMANT_DAYS } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';
import { CrmDormantsService } from './crm-dormants.service';
import { PrismaService } from 'src/database/services/prisma.service';

const MAINTENANT = new Date('2026-10-09T10:00:00.000Z');

describe('limiteDormants', () => {
  it('recule du nombre de jours demandé', () => {
    expect(limiteDormants(MAINTENANT, 7).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });
});

describe('conditionDormants', () => {
  const c = conditionDormants(limiteDormants(MAINTENANT, DEFAULT_DORMANT_DAYS));

  it('ne réveille jamais un contact supprimé', () => {
    expect(c.entity_status).toEqual({ not: EntityStatus.DELETED });
  });

  it('ne vise que les deux statuts ouverts qui dormaient', () => {
    expect(c.OR.map((o) => o.status)).toEqual([
      CrmStatus.INTERESSE,
      CrmStatus.COUPON_ENVOYE,
      CrmStatus.COUPON_ENVOYE,
    ]);
  });

  /**
   * Le cas qui dormirait pour toujours : un coupon sans date d'envoi. Sans ce
   * repli sur le dernier appel, il ne serait jamais réveillé, c'est-à-dire
   * exactement le défaut qu'on corrige.
   */
  it('juge un coupon sans date d’envoi sur le dernier appel', () => {
    const repli = c.OR[2];
    expect(repli.coupon_sent_at).toBeNull();
    expect(repli.last_call_at).toEqual({ lte: limiteDormants(MAINTENANT, DEFAULT_DORMANT_DAYS) });
  });
});

function monter(dormants: { id: string; status: CrmStatus; campaign_id: string | null }[], dejaPris: string[] = []) {
  const evenements: Record<string, unknown>[] = [];
  const prisma = {
    crmContact: {
      findMany: jest.fn().mockResolvedValue(dormants),
      updateMany: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ count: dejaPris.includes(where.id) ? 0 : 1 }),
      ),
    },
    crmEvent: { create: jest.fn((a: { data: Record<string, unknown> }) => { evenements.push(a.data); return Promise.resolve({}); }) },
  } as unknown as PrismaService;
  const config = { lireReglages: () => Promise.resolve({ dormant_days: 7 }) } as unknown as CrmConfigService;
  return { service: new CrmDormantsService(prisma, config), prisma, evenements };
}

describe('CrmDormantsService', () => {
  it('remet un intéressé endormi à appeler, et le trace', async () => {
    const { service, prisma, evenements } = monter([
      { id: 'c1', status: CrmStatus.INTERESSE, campaign_id: 'camp1' },
    ]);
    expect(await service.reveiller(MAINTENANT)).toBe(1);
    expect((prisma.crmContact.updateMany as jest.Mock).mock.calls[0][0].data).toEqual({
      status: CrmStatus.A_APPELER,
    });
    expect(evenements[0]).toMatchObject({
      contact_id: 'c1',
      campaign_id: 'camp1',
      type: CrmEventType.RETOUR,
    });
  });

  /**
   * Le test qui compte : un agent qui vient de rappeler, ou un second backend,
   * change le statut entre la lecture et l'écriture. Sans revendication, on
   * écraserait son travail et on écrirait un événement en double.
   */
  it('n’écrit rien quand le contact a bougé entre la lecture et l’écriture', async () => {
    const { service, evenements } = monter(
      [
        { id: 'c1', status: CrmStatus.INTERESSE, campaign_id: null },
        { id: 'c2', status: CrmStatus.COUPON_ENVOYE, campaign_id: null },
      ],
      ['c1'],
    );
    expect(await service.reveiller(MAINTENANT)).toBe(1);
    expect(evenements.map((e) => e.contact_id)).toEqual(['c2']);
  });

  it('ne fait rien, et n’écrit rien, quand personne ne dort', async () => {
    const { service, prisma } = monter([]);
    expect(await service.reveiller(MAINTENANT)).toBe(0);
    expect(prisma.crmContact.updateMany).not.toHaveBeenCalled();
  });
});
