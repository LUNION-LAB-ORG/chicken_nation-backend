import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateNotificationStatusDto {
  @ApiProperty({
    description: 'Statut de lecture de la notification',
    example: true,
  })
  @IsBoolean()
  @IsNotEmpty()
  isRead: boolean;
}
