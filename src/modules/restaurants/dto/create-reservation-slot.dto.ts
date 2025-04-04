import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateReservationSlotDto {
  @ApiProperty({ description: 'Cru00e9neau horaire pour les ru00e9servations (ex: "18:00", "19:30")' })
  @IsString()
  time_slot: string;
}
