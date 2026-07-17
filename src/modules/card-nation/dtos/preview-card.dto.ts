import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CardType } from './review-card-request.dto';

/**
 * Aperçu d'un design de carte (backoffice : galerie des designs / testeur de
 * génération par niveau). Rend l'image AVEC LE VRAI générateur, mais en mode
 * render-only : rien n'est écrit en base ni uploadé sur S3.
 */
export class PreviewCardDto {
    @ApiProperty({
        description: 'Type de carte à prévisualiser',
        enum: CardType,
        example: CardType.VIP,
    })
    @IsEnum(CardType)
    @IsNotEmpty({ message: 'Le type de carte est requis' })
    card_type: CardType;

    @ApiPropertyOptional({ description: "Prénom affiché sur l'aperçu", example: 'Awa' })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    first_name?: string;

    @ApiPropertyOptional({ description: "Nom affiché sur l'aperçu", example: 'Koné' })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    last_name?: string;

    @ApiPropertyOptional({ description: "Pseudo affiché sur l'aperçu", example: 'Jojo' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    nickname?: string;
}
