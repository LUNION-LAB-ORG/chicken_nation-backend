
import { IsEnum, IsString, IsOptional, IsNotEmpty, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CardRequestStatus } from '@prisma/client';

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
}
