import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LoyaltyLevel } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
    IsBoolean,
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    MaxLength,
} from 'class-validator';

/**
 * Aperçu d'un design de carte (backoffice : galerie des designs / testeur).
 * Rend l'image AVEC LE VRAI générateur, en mode render-only : rien n'est écrit
 * en base ni uploadé sur S3.
 *
 * Deux axes (cahier §4.5) : `level` = la couleur, `is_student` = le marqueur jaune.
 */
export class PreviewCardDto {
    @ApiProperty({
        description: 'Niveau à prévisualiser (couleur de la carte)',
        enum: LoyaltyLevel,
        example: LoyaltyLevel.VIP,
    })
    @IsEnum(LoyaltyLevel)
    @IsNotEmpty({ message: 'Le niveau est requis' })
    level: LoyaltyLevel;

    @ApiPropertyOptional({
        description: 'Marqueur étudiant (badge/liseré jaune) par-dessus le niveau',
        example: false,
    })
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true')
    @IsBoolean()
    is_student?: boolean;

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
