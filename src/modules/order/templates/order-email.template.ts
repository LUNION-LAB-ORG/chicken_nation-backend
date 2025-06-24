import { Injectable } from "@nestjs/common";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { getOrderEmailContent } from "../constantes/order-email.constante";
import { OrderStatus } from "@prisma/client";


@Injectable()
export class OrderEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService
    ) { }

    // STATUT COMMANDE - Pour le client
    NOTIFICATION_ORDER_CUSTOMER: EmailTemplate<{
        reference: string;
        status: OrderStatus;
        amount: number;
        restaurant_name: string;
        customer_name: string;
        delivery_address?: string;
    }> = {
            subject: (ctx) => getOrderEmailContent(ctx.data, 'customer', this.emailComponentsService).subject,
            content: (ctx) => getOrderEmailContent(ctx.data, 'customer', this.emailComponentsService).content,
        };

    // STATUT COMMANDE - Pour le restaurant
    NOTIFICATION_ORDER_RESTAURANT: EmailTemplate<{
        reference: string;
        status: OrderStatus;
        amount: number;
        restaurant_name: string;
        customer_name: string;
    }> = {
            subject: (ctx) => getOrderEmailContent(ctx.data, 'restaurant', this.emailComponentsService).subject,
            content: (ctx) => getOrderEmailContent(ctx.data, 'restaurant', this.emailComponentsService).content,
        };
}