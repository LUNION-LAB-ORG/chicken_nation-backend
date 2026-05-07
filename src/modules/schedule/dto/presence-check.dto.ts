import { ApiProperty } from '@nestjs/swagger';
import { PresenceCheckResponse } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class PresenceCheckDto {
  @ApiProperty({
    description: "Réponse au check-in matinal de présence",
    enum: PresenceCheckResponse,
    example: 'PRESENT',
  })
  @IsEnum(PresenceCheckResponse)
  response!: PresenceCheckResponse;
}
