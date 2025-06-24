import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/database/services/prisma.service";
import { NotificationRecipient } from "../interfaces/notifications.interface";
import { User, UserRole, UserType, Customer } from "@prisma/client";

@Injectable()
export class NotificationRecipientsService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Mapping User, Customer with NotificationRecipient
     * @param users (User & { restaurant?: { name: string } })[]
     * @param type "restaurant_user" | "backoffice_user"
     * @returns NotificationRecipient[]
     */

    async mapUserToNotificationRecipient(users: (User & { restaurant?: { name: string } })[], type: "restaurant_user" | "backoffice_user"): Promise<NotificationRecipient[]> {

        return users.map(user => {
            return {
                id: user.id,
                type,
                name: user.fullname,
                email: user?.email ?? undefined,
                phone: user?.phone ?? undefined,
                restaurant_id: user.restaurant_id ?? undefined,
                restaurant_name: user.restaurant?.name ?? undefined
            };
        });
    }

    /**
     * Mapping Customer with NotificationRecipient
     * @param customers Customer[]
     * @returns NotificationRecipient[]
     */

    async mapCustomerToNotificationRecipient(customers: Customer[]): Promise<NotificationRecipient[]> {
        return customers.map(customer => {
            return {
                id: customer.id,
                type: "customer",
                name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
                loyalty_level: customer.loyalty_level,
                total_points: customer.total_points,
                lifetime_points: customer.lifetime_points,
                email: customer?.email ?? undefined,
                phone: customer?.phone ?? undefined
            };
        });
    }

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
                restaurant_id: true,
                role: true,
                email: true,
                phone: true,
                restaurant: {
                    select: {
                        name: true
                    }
                }
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'restaurant_user',
            role: user.role,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined,
            restaurant_id: user.restaurant_id ?? undefined,
            restaurant_name: user.restaurant?.name ?? undefined
        }));
    }
    async getRestaurantManager(restaurantId: string): Promise<NotificationRecipient[]> {
        const users = await this.prisma.user.findMany({
            where: {
                role: UserRole.MANAGER,
                restaurant_id: restaurantId,
                entity_status: 'ACTIVE'
            },
            select: {
                id: true,
                fullname: true,
                restaurant_id: true,
                role: true,
                email: true,
                phone: true,
                restaurant: {
                    select: {
                        name: true
                    }
                }
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'restaurant_user',
            role: user.role,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined,
            restaurant_id: user.restaurant_id ?? undefined,
            restaurant_name: user.restaurant?.name ?? undefined
        }));
    }

    /**
     * Récupère tous les managers d'un restaurant
     */
    async getAllRestaurantManagers(): Promise<NotificationRecipient[]> {
        const users = await this.prisma.user.findMany({
            where: {
                role: UserRole.MANAGER,
                type: "RESTAURANT",
                entity_status: 'ACTIVE',
            },
            select: {
                id: true,
                fullname: true,
                restaurant_id: true,
                role: true,
                email: true,
                phone: true,
                restaurant: {
                    select: {
                        name: true
                    }
                }
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'restaurant_user',
            role: user.role,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined,
            restaurant_id: user.restaurant_id ?? undefined,
            restaurant_name: user.restaurant?.name ?? undefined
        }));
    }

    /**
     * Récupère tous les utilisateurs des restaurants
     */
    async getAllRestaurantUsers(): Promise<NotificationRecipient[]> {
        const users = await this.prisma.user.findMany({
            where: {
                type: "RESTAURANT",
                entity_status: 'ACTIVE'
            },
            select: {
                id: true,
                fullname: true,
                restaurant_id: true,
                role: true,
                email: true,
                phone: true,
                restaurant: {
                    select: {
                        name: true
                    }
                }
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'restaurant_user',
            role: user.role,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined,
            restaurant_id: user.restaurant_id ?? undefined,
            restaurant_name: user.restaurant?.name ?? undefined
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
                fullname: true,
                role: true,
                email: true,
                phone: true
            }
        });

        return users.map(user => ({
            id: user.id,
            type: 'backoffice_user',
            role: user.role,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined
        }));
    }
    /**
     * Récupère un utilisateur qui est soit backoffice_user soit restaurant_user
     */
    async getUser(userId: string, userType: 'backoffice_user' | 'restaurant_user'): Promise<NotificationRecipient | null> {
        const user = await this.prisma.user.findUnique({
            where: {
                id: userId,
                type: userType == "backoffice_user" ? UserType.BACKOFFICE : UserType.RESTAURANT
            },
            select: {
                id: true,
                fullname: true,
                email: true,
                phone: true
            }
        });

        if (!user) return null;

        return {
            id: user.id,
            type: userType,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined
        };
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
                last_name: true,
                loyalty_level: true,
                total_points: true,
                lifetime_points: true,
                email: true,
                phone: true
            }
        });

        if (!customer) return null;

        return {
            id: customer.id,
            type: 'customer',
            name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            loyalty_level: customer.loyalty_level,
            total_points: customer.total_points,
            lifetime_points: customer.lifetime_points,
            email: customer?.email ?? undefined,
            phone: customer?.phone ?? undefined
        };
    }

    async getCustomers(): Promise<NotificationRecipient[]> {
        const customers = await this.prisma.customer.findMany({
            select: {
                id: true,
                first_name: true,
                last_name: true,
                loyalty_level: true,
                total_points: true,
                lifetime_points: true,
                email: true,
                phone: true
            }
        });

        return customers.map(customer => ({
            id: customer.id,
            type: 'customer',
            name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            loyalty_level: customer.loyalty_level,
            total_points: customer.total_points,
            lifetime_points: customer.lifetime_points,
            email: customer?.email ?? undefined,
            phone: customer?.phone ?? undefined
        }));
    }
}