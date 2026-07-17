import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LoyaltyLevel } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional } from 'class-validator';

/**
 * Régénération du visuel d'une carte existante, avec les DEUX AXES imposés par
 * le staff (cahier §4.5) : `level` = la couleur, `is_student` = le marqueur jaune.
 * Le numéro de carte et le QR sont conservés : seule l'image change.
 */
export class RegenerateCardDto {
    @ApiProperty({
        description: 'Niveau de la carte (couleur)',
        enum: LoyaltyLevel,
        example: LoyaltyLevel.VIP,
    })
    @IsEnum(LoyaltyLevel)
    @IsNotEmpty({ message: 'Le niveau est requis' })
    level: LoyaltyLevel;

    @ApiPropertyOptional({
        description: 'Marqueur étudiant (badge/liseré jaune), indépendant du niveau',
        example: false,
    })
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true')
    @IsBoolean()
    is_student?: boolean;
}
