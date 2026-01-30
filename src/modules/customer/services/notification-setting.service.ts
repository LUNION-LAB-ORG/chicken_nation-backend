import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/database/services/prisma.service";
import { UpdateNotificationSettingDto } from "../dto/update-notification-setting.dto";

@Injectable()
export class NotificationSettingService {
    constructor(private readonly prisma: PrismaService) { }

    async update(customerId: string, dto: UpdateNotificationSettingDto) {
        const existing = await this.prisma.notificationSetting.findUnique({
            where: { customer_id: customerId },
        });

        if (!existing) {
            // Créer ses paramètres de notifications
            return await this.prisma.notificationSetting.create({
                data: {
                    customer_id: customerId,
                },
            });
        }

        return this.prisma.notificationSetting.update({
            where: { customer_id: customerId },
            data: dto,
        });
    }
}
