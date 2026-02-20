import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { AssignmentService } from './../services/assignment.service';

@Processor('tickets')
export class TicketsConsumer extends WorkerHost {
  private logger = new Logger(TicketsConsumer.name);
  constructor(
    private readonly assignmentService: AssignmentService,
  ) {
    super();
  }

  async process(
    job: Job,
    token?: string,
  ): Promise<any> {
    this.logger.log(`Processing job ${job.id}`);
    const { ticketId, categoryId } = job.data;

    const result = await this.assignmentService.autoAssignTicket(
      ticketId,
      categoryId,
    );

    if (!result) {
      throw new Error('No agents available, retrying...');
    }

    return result;
  }

}