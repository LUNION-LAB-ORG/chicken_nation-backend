import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProspectCallResult } from '@prisma/client';

/**
 * Qualification d'un appel call center (cf. cahier §4.5).
 */
export class MarkCallDto {
  @ApiProperty({ enum: ProspectCallResult, example: ProspectCallResult.JOINT })
  @IsEnum(ProspectCallResult, {
    message: 'Résultat invalide (JOINT, NON_JOIGNABLE ou REFUS)',
  })
  result: ProspectCallResult;

  @ApiPropertyOptional({ description: "Note libre de l'agent" })
  @IsOptional()
  @IsString()
  note?: string;
}
