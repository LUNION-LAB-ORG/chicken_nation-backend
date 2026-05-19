import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { AssignmentService } from '../services/assignment.service';

@Processor('tickets')
export class TicketsConsumer extends WorkerHost {
  private readonly logger = new Logger(TicketsConsumer.name);

  constructor(
    private readonly assignmentService: AssignmentService,
  ) {
    super();
  }

  async process(job: any, token?: string): Promise<any> {
    const { ticketId, categoryId } = job.data;
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 1;

    this.logger.log(
      `Processing ticket ${ticketId} (tentative ${attemptsMade + 1}/${maxAttempts})`,
    );

    const result = await this.assignmentService.autoAssignTicket(
      ticketId,
      categoryId,
    );

    if (!result) {
      // Pas d'agent dispo OU tous saturés. On laisse BullMQ retry jusqu'à
      // l'épuisement des tentatives. Si l'épuisement est atteint, le ticket
      // sera ré-enfilé via @OnEvent('user.online') quand un agent compétent
      // se connectera (cf. TicketListenerService).
      const remaining = maxAttempts - attemptsMade - 1;
      if (remaining <= 0) {
        this.logger.warn(
          `Ticket ${ticketId} : aucun agent disponible après ${maxAttempts} tentatives. ` +
          `Le ticket reste en pending et sera ré-enfilé à la prochaine connexion d'un agent compétent.`,
        );
      } else {
        this.logger.warn(
          `Ticket ${ticketId} : aucun agent disponible, retry dans 30s (${remaining} tentative(s) restante(s))`,
        );
      }

      // Throw pour déclencher le retry BullMQ
      throw new Error('No agents available');
    }

    this.logger.log(
      `Ticket ${ticketId} assigné à l'agent ${result.id}`,
    );

    return result;
  }
}
