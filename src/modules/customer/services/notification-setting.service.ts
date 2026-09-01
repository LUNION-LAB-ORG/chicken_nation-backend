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

        /**
         * ⚠️ Un nouveau jeton ANNULE une révocation précédente.
         *
         * Un client qui réinstalle l'application obtient un nouveau jeton et le
         * transmet ici. Si son ancien jeton avait été révoqué parce qu'Expo le
         * disait inconnu, laisser la trace en place n'aurait pas d'effet
         * technique, mais fausserait toute lecture ultérieure de l'historique
         * de révocation. On repart donc d'une ardoise propre.
         */
        return this.prisma.notificationSetting.update({
            where: { customer_id: customerId },
            data: {
                ...dto,
                ...(dto.expo_push_token
                    ? { expo_push_token_revoked: null, expo_push_token_revoked_at: null }
                    : {}),
            },
        });
    }
}
