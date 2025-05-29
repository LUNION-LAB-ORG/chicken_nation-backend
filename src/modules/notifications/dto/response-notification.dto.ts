import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NotificationType, NotificationTarget } from "@prisma/client";

export class NotificationResponseDto {
    @ApiProperty({
        description: 'Identifiant unique de la notification',
        example: '550e8400-e29b-41d4-a716-446655440000'
    })
    id: string;

    @ApiProperty({
        description: 'Titre de la notification',
        example: 'Nouvelle commande reçue'
    })
    title: string;

    @ApiProperty({
        description: 'Message de la notification',
        example: 'Votre commande #CMD-001 a été confirmée.'
    })
    message: string;

    @ApiProperty({
        enum: NotificationType,
        description: 'Type de notification'
    })
    type: NotificationType;

    @ApiProperty({
        description: 'Statut de lecture',
        example: false
    })
    is_read: boolean;

    @ApiProperty({
        description: 'Identifiant de l\'utilisateur destinataire'
    })
    user_id: string;

    @ApiProperty({
        enum: NotificationTarget,
        description: 'Cible de la notification'
    })
    target: NotificationTarget;

    @ApiProperty({
        description: 'URL de l\'icône'
    })
    icon: string;

    @ApiProperty({
        description: 'Couleur de fond de l\'icône'
    })
    icon_bg_color: string;

    @ApiProperty({
        description: 'Affichage du chevron'
    })
    show_chevron: boolean;

    @ApiPropertyOptional({
        description: 'Données supplémentaires',
        required: false
    })
    data?: any;

    @ApiProperty({
        description: 'Date de création',
        example: '2024-01-15T10:30:00Z'
    })
    created_at: Date;

    @ApiProperty({
        description: 'Date de dernière mise à jour',
        example: '2024-01-15T10:30:00Z'
    })
    updated_at: Date;
}