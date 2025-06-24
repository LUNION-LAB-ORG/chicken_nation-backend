import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/database/services/prisma.service";
import { Prisma, UserRole, UserType, EntityStatus } from "@prisma/client";

@Injectable()
export class EmailRecipientService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Récupère tous les utilisateurs d'un restaurant
     */
    async getAllUsersByRestaurantAndRole(restaurantId?: string, roles?: UserRole[]): Promise<string[]> {
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
            select: {
                email: true,
            }
        });

        return users.map(user => user.email);
    }

    async getManagerByRestaurant(restaurantId: string): Promise<string[]> {
        const managers = this.getAllUsersByRestaurantAndRole(restaurantId, [UserRole.MANAGER]);
        return managers;
    }

    /**
     * Récupère tous les managers d'un restaurant
     */
    async getAllManagers(): Promise<string[]> {
        const managers = this.getAllUsersByRestaurantAndRole(undefined, [UserRole.MANAGER]);
        return managers;
    }

    /**
     * Récupère tous les utilisateurs des restaurants
     */
    async getAllUsersRestaurant(): Promise<string[]> {
        const users = this.getAllUsersByRestaurantAndRole(undefined, []);
        return users;
    }


    /**
    * Récupère tous les utilisateurs du back office
    */
    async getAllUsersByBackofficeAndRole(roles?: UserRole[]): Promise<string[]> {
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
            select: {
                email: true,
            }
        });

        return users.map(user => user.email);
    }

    async getAllCustomers(): Promise<string[]> {
        const customers = await this.prisma.customer.findMany({
            where: {
                entity_status: EntityStatus.ACTIVE,
                email: {
                    not: null
                }
            },
            select: {
                email: true,
            }
        });

        return customers.map(customer => customer.email!);
    }
}