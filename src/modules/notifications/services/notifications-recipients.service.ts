import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/database/services/prisma.service";
import { NotificationRecipient } from "../interfaces/notifications.interface";

@Injectable()
export class NotificationRecipientsService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Récupère tous les utilisateurs d'un restaurant
     */
    async getRestaurantUsers(restaurantId: string): Promise<NotificationRecipient[]> {
        const users = await this.prisma.user.findMany({
            where: {
                restaurant_id: restaurantId,
                entity_status: 'ACTIVE'
            },
            select: {
                id: true,
                fullname: true,
                restaurant_id: true
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'restaurant_user',
            name: user.fullname,
            restaurant_id: user.restaurant_id ?? undefined
        }));
    }

    /**
     * Récupère tous les utilisateurs du back office
     */
    async getBackofficeUsers(): Promise<NotificationRecipient[]> {
        const users = await this.prisma.user.findMany({
            where: {
                type: 'BACKOFFICE',
                entity_status: 'ACTIVE'
            },
            select: {
                id: true,
                fullname: true
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'backoffice_user',
            name: user.fullname
        }));
    }

    /**
     * Récupère un client
     */
    async getCustomer(customerId: string): Promise<NotificationRecipient | null> {
        const customer = await this.prisma.customer.findUnique({
            where: { id: customerId },
            select: {
                id: true,
                first_name: true,
                last_name: true
            }
        });

        if (!customer) return null;

        return {
            id: customer.id,
            type: 'customer',
            name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
        };
    }
}