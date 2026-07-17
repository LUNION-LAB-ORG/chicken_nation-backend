
import { IsEnum, IsString, IsOptional, IsNotEmpty, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CardRequestStatus } from '@prisma/client';

/**
 * Type de carte choisi par le staff À L'APPROBATION (backoffice).
 * Détermine le visuel émis :
 *  - ETUDIANT           → carte étudiante (liseré jaune), couleur = niveau du client ;
 *  - STANDARD/VIP/VVIP  → carte de ce niveau, non étudiante.
 * Absent → dérivation automatique (niveau du client + profil déclaré) : rétro-compat.
 */
export enum CardType {
    ETUDIANT = 'ETUDIANT',
    STANDARD = 'STANDARD',
    VIP = 'VIP',
    VVIP = 'VVIP',
}

export class ReviewCardRequestDto {
    @ApiProperty({
        description: 'Nouveau statut de la demande',
        enum: CardRequestStatus,
        example: CardRequestStatus.APPROVED
    })
    @IsEnum(CardRequestStatus)
    @IsNotEmpty({ message: 'Le statut est requis' })
    status: CardRequestStatus;

    @ApiPropertyOptional({ description: 'Motif de rejet (requis si status = REJECTED)' })
    @IsOptional()
    @IsString()
    @ValidateIf((o) => o.status === CardRequestStatus.REJECTED)
    @IsNotEmpty({ message: 'Le motif de rejet est requis' })
    rejection_reason?: string;

    @ApiPropertyOptional({
        description:
            "Type de carte à émettre, choisi à l'approbation. Absent → dérivation auto.",
        enum: CardType,
        example: CardType.STANDARD,
    })
    @IsOptional()
    @IsEnum(CardType)
    card_type?: CardType;
}
