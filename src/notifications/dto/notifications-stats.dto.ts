import { ApiProperty } from "@nestjs/swagger";

export class NotificationStatsDto {
    @ApiProperty({
        description: 'Nombre total de notifications',
        example: 50
    })
    total: number;

    @ApiProperty({
        description: 'Nombre de notifications non lues',
        example: 12
    })
    unread: number;

    @ApiProperty({
        description: 'Nombre de notifications lues',
        example: 38
    })
    read: number;

    @ApiProperty({
        description: 'Répartition par type de notification',
        example: {
            ORDER: 25,
            PROMOTION: 15,
            SYSTEM: 10
        }
    })
    by_type: Record<string, number>;
}
