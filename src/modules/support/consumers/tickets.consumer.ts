import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { AssignmentService } from './../services/assignment.service';
import { Logger } from "@nestjs/common";

@Processor('tickets')
export class TicketsConsumer extends WorkerHost {
    private logger = new Logger(TicketsConsumer.name);
    constructor(
        private readonly assignmentService: AssignmentService,
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        this.logger.log(`Processing job ${job.id}`);
        const { ticketId, categoryId } = job.data;

        this.logger.log(`Auto-assigning ticket ${ticketId} in category ${categoryId}`);
        const result = await this.assignmentService.autoAssignTicket(ticketId, categoryId);

        if (!result) {
            // Remettre le job dans la file d'attente pour une nouvelle tentative dans 10 secondes
            this.logger.log(`Re-queued job ${job.id} for ticket ${ticketId} after 10 seconds`);
            throw new Error('No agents available, retrying...');
        }

        this.logger.log(`Successfully assigned ticket ${ticketId} to agent ${result.id}`);
        return result;
    }
}