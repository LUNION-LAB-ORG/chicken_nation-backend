
import { IsBoolean, IsEnum, IsString, IsOptional, IsNotEmpty, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CardRequestStatus, LoyaltyLevel } from '@prisma/client';

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

    /* ============================================================
       Carte émise à l'approbation — DEUX AXES INDÉPENDANTS (cahier §4.5) :
        - `level`      : la COULEUR de la carte (Standard → VIP → VVIP) ;
        - `is_student` : le MARQUEUR jaune, posé PAR-DESSUS le niveau.
       Un étudiant peut donc être « Étudiant + VIP ».
       Absents → dérivation auto (niveau du client + profil déclaré).
    ============================================================ */

    @ApiPropertyOptional({
        description: "Niveau de la carte à émettre (couleur). Absent → niveau du client.",
        enum: LoyaltyLevel,
        example: LoyaltyLevel.VIP,
    })
    @IsOptional()
    @IsEnum(LoyaltyLevel)
    level?: LoyaltyLevel;

    @ApiPropertyOptional({
        description: "Marqueur étudiant (badge/liseré jaune), indépendant du niveau.",
        example: true,
    })
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true')
    @IsBoolean()
    is_student?: boolean;
}
