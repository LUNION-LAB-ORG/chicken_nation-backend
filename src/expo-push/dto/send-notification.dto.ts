import { IsString, IsArray, IsOptional, IsObject, IsNumber, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type NotificationPriority = 'default' | 'normal' | 'high';

export class SendNotificationDto {
    @ApiProperty({
        description: "Liste des tokens Expo Push des utilisateurs cibles",
        example: ["ExponentPushToken[xxxxxxxx]", "ExponentPushToken[yyyyyyyy]"],
        type: [String]
    })
    @IsArray()
    @IsString({ each: true })
    tokens: string[];

    @ApiProperty({
        description: "Le titre principal de la notification",
        example: "Commande Prête ! 🍗"
    })
    @IsString()
    title: string;

    @ApiProperty({
        description: "Le corps du message",
        example: "Votre menu XL est disponible au comptoir."
    })
    @IsString()
    body: string;

    @ApiPropertyOptional({
        description: "Données JSON invisibles pour la logique app (redirection, ID...)",
        example: { menuId: "123", url: "/orders/history" },
    })
    @IsObject()
    @IsOptional()
    data?: Record<string, any>;

    @ApiPropertyOptional({
        description: "Sous-titre (iOS uniquement)",
        example: "Restaurant Cocody"
    })
    @IsString()
    @IsOptional()
    subtitle?: string;

    @ApiPropertyOptional({
        description: "Jouer un son ? 'default' ou null pour silencieux",
        default: 'default',
        example: 'default'
    })
    @IsString()
    @IsOptional()
    sound?: string | null;

    @ApiPropertyOptional({
        description: "Le chiffre dans la pastille rouge sur l'icône de l'app",
        example: 1
    })
    @IsNumber()
    @IsOptional()
    badge?: number;

    @ApiPropertyOptional({
        description: "Priorité de livraison (surtout pour Android)",
        default: "high"
    })
    @IsString()
    @IsOptional()
    priority?: NotificationPriority;

    @ApiPropertyOptional({
        description: "Durée de vie du message en secondes (si le tel est éteint)",
        example: 3600 // 1 heure
    })
    @IsNumber()
    @IsOptional()
    ttl?: number;

    @ApiPropertyOptional({
        description: "ID du canal Android (doit matcher ta config app.json)",
        default: 'default',
        example: 'default'
    })
    @IsString()
    @IsOptional()
    channelId?: string;

    @ApiPropertyOptional({
        description: "ID de catégorie pour les actions interactives (ex: bouton 'Accepter')",
        example: 'new-order'
    })
    @IsString()
    @IsOptional()
    categoryId?: string;
}