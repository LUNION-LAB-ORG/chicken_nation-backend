import { Injectable, Logger } from '@nestjs/common';
import { ConversionEventType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { CONVERSION_SOCKET_EVENT } from '../conversion.rules';

export interface EvenementProspect {
  prospect_id: string;
  type: ConversionEventType;
  label: string;
  actor_id?: string | null;
  campaign_id?: string | null;
  data?: Prisma.InputJsonValue;
}

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Journal horodaté de chaque prospect (qui, quoi, quand) et signal temps réel
 * vers le backoffice : l'écran d'un agent retire un prospect à la seconde où
 * celui-ci commande, pour qu'on ne l'appelle pas pour rien.
 */
@Injectable()
export class ConversionEventsService {
  private readonly logger = new Logger(ConversionEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AppGateway,
  ) {}

  async journaliser(evenements: EvenementProspect[], client: Client = this.prisma) {
    if (evenements.length === 0) return;
    await client.conversionEvent.createMany({
      data: evenements.map((e) => ({
        prospect_id: e.prospect_id,
        type: e.type,
        label: e.label.slice(0, 255),
        actor_id: e.actor_id ?? null,
        campaign_id: e.campaign_id ?? null,
        data: e.data,
      })),
    });
  }

  signaler(prospectIds: string[], motif: string) {
    if (prospectIds.length === 0) return;
    try {
      this.gateway.emitToBackoffice(CONVERSION_SOCKET_EVENT, { ids: prospectIds, motif });
    } catch (e) {
      // Le temps réel est un confort : son échec ne doit jamais casser une écriture.
      this.logger.warn(`Signal ${CONVERSION_SOCKET_EVENT} non émis : ${(e as Error).message}`);
    }
  }
}
