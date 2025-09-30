import { Injectable, Logger } from "@nestjs/common";
import { TicketStatus, User } from "@prisma/client";
import { PrismaService } from "src/database/services/prisma.service";
import { AssigneeResponseDto } from "../dtos/response-assignee.dto";
import { AppGateway } from "src/socket-io/gateways/app.gateway";

@Injectable()
export class AssignmentService {
	private logger = new Logger(AssignmentService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly appGateway: AppGateway,
	) { }



	async getAgentListByCategory(categoryId: string) {
		return await this.prisma.ticketUserSkill.findMany({
			where: { categoryId },
			include: {
				user: {
					select: {
						id: true,
						fullname: true,
						email: true,
						phone: true,
						image: true,
						role: true
					}
				}
			}
		});
	}

	async getOnlineAgentsByCategory(categoryId: string) {
		const agents = await this.getAgentListByCategory(categoryId);
		this.logger.log(`Found ${agents.length} agents for category ${categoryId}`);
		return agents.filter(agent => this.appGateway.isUserOnline(agent.user.id));
	}

	async getTicketCountByAgent(agentId: string) {
		return await this.prisma.ticketThread.count({
			where: {
				assigneeId: agentId,
				status: TicketStatus.OPEN
			}
		});
	}

	async assignTicketToAgent(ticketId: string, agentId: string): Promise<AssigneeResponseDto | null> {
		const assigned = await this.prisma.ticketThread.update({
			where: { id: ticketId },
			data: { assigneeId: agentId },
			include: { assignee: true }
		});

		this.logger.log(`Ticket ${ticketId} assigned to agent ${agentId}`);

		if (assigned) {
			this.logger.log(`Emitting ticket assignment to agent ${agentId}`);
			this.appGateway.emitToUser(agentId, "user", 'ticket.assigned', {
				ticketId: assigned.id,
				assignee: this.mapFieldsToDto(assigned.assignee as User)
			});
		}

		return assigned?.assignee || null;
	}

	async autoAssignTicket(ticketId: string, categoryId: string): Promise<AssigneeResponseDto | null> {

		const agents = await this.getOnlineAgentsByCategory(categoryId);
		if (agents.length === 0) {
			return null; // No agents available for this category
		}

		// Le nombre de tickets par agent
		const agentTicketCounts = await Promise.all(
			agents.map(agent => this.getTicketCountByAgent(agent.user.id))
		);

		const minTickets = Math.min(...agentTicketCounts); // Le nombre de tickets le plus bas
		const maxTicketsPerAgent = 5; // Limite de tickets par agent

		if (minTickets >= maxTicketsPerAgent) {
			return null; // Tous les agents ont atteint la limite de tickets
		}

		const selectedAgent = agents[agentTicketCounts.indexOf(minTickets)]; // L'agent avec le moins de tickets

		// Assigner le ticket à l'agent sélectionné
		return await this.assignTicketToAgent(ticketId, selectedAgent.user.id);
	}

	mapFieldsToDto(user: User): AssigneeResponseDto {
		return {
			id: user.id,
			fullname: user.fullname,
			image: user.image || null,
		};
	}
}