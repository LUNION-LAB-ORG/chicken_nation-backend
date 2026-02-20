import { Processor, WorkerHost, Job } from '@nestjs/bullmq';
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

  async process(job: Job, token?: string): Promise<any> {
    this.logger.log(`Processing job ${job.id}`);

    const { ticketId, categoryId } = job.data;
    this.logger.debug(`Job data: ${JSON.stringify(job.data)}`);

    this.logger.log(
      `Auto-assigning ticket ${ticketId} in category ${categoryId}`,
    );

    const result = await this.assignmentService.autoAssignTicket(
      ticketId,
      categoryId,
    );

    if (!result) {
      this.logger.warn(
        `No agents available for ticket ${ticketId}, retrying...`,
      );

      // En lançant une erreur, BullMQ retry automatiquement
      throw new Error('No agents available, retrying...');
    }

    this.logger.log(
      `Successfully assigned ticket ${ticketId} to agent ${result.id}`,
    );

    return result;
  }
}
