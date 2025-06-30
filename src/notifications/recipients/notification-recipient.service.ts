import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/database/services/prisma.service";
import { Prisma, UserRole, UserType, EntityStatus, Customer, User, Restaurant } from "@prisma/client";
import { NotificationRecipient } from "../interfaces/notifications.interface";

@Injectable()
export class NotificationRecipientService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Récupère tous les utilisateurs d'un restaurant
     */
    async getAllUsersByRestaurantAndRole(restaurantId?: string, roles?: UserRole[]): Promise<NotificationRecipient[]> {
        const whereClause: Prisma.UserWhereInput = {
            entity_status: EntityStatus.ACTIVE,
            type: UserType.RESTAURANT,
        };
        if (restaurantId) {
            whereClause.restaurant_id = restaurantId;
        }
        if (roles) {
            whereClause.role = {
                in: roles
            };
        }
        const users = await this.prisma.user.findMany({
            where: whereClause,
            include: {
                restaurant: true
            }
        });

        return users.map(user => this.mapUserToNotificationRecipient(user));
    }

    async getManagerByRestaurant(restaurantId: string): Promise<NotificationRecipient[]> {
        const managers = this.getAllUsersByRestaurantAndRole(restaurantId, [UserRole.MANAGER]);
        return managers;
    }

    /**
     * Récupère tous les managers d'un restaurant
     */
    async getAllManagers(): Promise<NotificationRecipient[]> {
        const managers = this.getAllUsersByRestaurantAndRole(undefined, [UserRole.MANAGER]);
        return managers;
    }

    /**
     * Récupère tous les utilisateurs des restaurants
     */
    async getAllUsersRestaurant(): Promise<NotificationRecipient[]> {
        const users = this.getAllUsersByRestaurantAndRole(undefined, []);
        return users;
    }


    /**
    * Récupère tous les utilisateurs du back office
    */
    async getAllUsersByBackofficeAndRole(roles?: UserRole[]): Promise<NotificationRecipient[]> {
        const whereClause: Prisma.UserWhereInput = {
            entity_status: EntityStatus.ACTIVE,
            type: UserType.BACKOFFICE,
        };
        if (roles) {
            whereClause.role = {
                in: roles
            };
        }
        const users = await this.prisma.user.findMany({
            where: whereClause,
            include: {
                restaurant: true
            }
        });

        return users.map(user => this.mapUserToNotificationRecipient(user));
    }

    /**
    * Récupère tous les clients
    */
    async getAllCustomers(): Promise<NotificationRecipient[]> {
        const customers = await this.prisma.customer.findMany({
            where: {
                entity_status: EntityStatus.ACTIVE,
                email: {
                    not: null
                }
            },
        });

        return customers.map(customer => this.mapCustomerToNotificationRecipient(customer));
    }

    /**
    * Récupère un clients
    */
    async getCustomer(customerId: string): Promise<NotificationRecipient> {
        const customer = await this.prisma.customer.findUnique({
            where: {
                id: customerId,
                entity_status: EntityStatus.ACTIVE,
            },
        });
        if (!customer) {
            throw new Error('Customer not found');
        }
        return this.mapCustomerToNotificationRecipient(customer);
    }

    async getUser(userId: string): Promise<NotificationRecipient> {
        const user = await this.prisma.user.findUnique({
            where: {
                id: userId,
                entity_status: EntityStatus.ACTIVE,
            },
            include: {
                restaurant: true
            }
        });
        if (!user) {
            throw new Error('User not found');
        }
        return this.mapUserToNotificationRecipient(user);
    }
    /**
     * Mapping Customer to NotificationRecipient
     */
    mapCustomerToNotificationRecipient(customer: Customer): NotificationRecipient {
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
    /**
     * Mapping User to NotificationRecipient
     */
    mapUserToNotificationRecipient(user: Prisma.UserGetPayload<{ include: { restaurant: true } }>): NotificationRecipient {
        return {
            id: user.id,
            type: user.type === UserType.RESTAURANT ? 'restaurant_user' : 'backoffice_user',
            role: user.role,
            name: user.fullname,
            email: user?.email ?? undefined,
            phone: user?.phone ?? undefined,
            restaurant_id: user.restaurant_id ?? undefined,
            restaurant_name: user.restaurant?.name ?? undefined
        };
    }
}