import { Injectable, Logger } from '@nestjs/common';
import { CrmEventType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { CRM_SOCKET_EVENT } from '../crm.rules';

export interface EvenementContact {
  contact_id: string;
  type: CrmEventType;
  label: string;
  actor_id?: string | null;
  campaign_id?: string | null;
  data?: Prisma.InputJsonValue;
}

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Journal horodaté de chaque contact (qui, quoi, quand) et signal temps réel
 * vers le backoffice : l'écran d'un agent retire un contact à la seconde où
 * celui-ci commande, pour qu'on ne l'appelle pas pour rien.
 */
@Injectable()
export class CrmEventsService {
  private readonly logger = new Logger(CrmEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AppGateway,
  ) {}

  async journaliser(evenements: EvenementContact[], client: Client = this.prisma) {
    if (evenements.length === 0) return;
    await client.crmEvent.createMany({
      data: evenements.map((e) => ({
        contact_id: e.contact_id,
        type: e.type,
        label: e.label.slice(0, 255),
        actor_id: e.actor_id ?? null,
        campaign_id: e.campaign_id ?? null,
        data: e.data,
      })),
    });
  }

  signaler(contactIds: string[], motif: string) {
    if (contactIds.length === 0) return;
    try {
      this.gateway.emitToBackoffice(CRM_SOCKET_EVENT, { ids: contactIds, motif });
    } catch (e) {
      // Le temps réel est un confort : son échec ne doit jamais casser une écriture.
      this.logger.warn(`Signal ${CRM_SOCKET_EVENT} non émis : ${(e as Error).message}`);
    }
  }
}
