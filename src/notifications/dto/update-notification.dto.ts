import { CreateNotificationDto } from './create-notification.dto';
import { PartialType } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNotificationDto extends PartialType(CreateNotificationDto) {

    @ApiPropertyOptional({
        description: 'Statut de lecture de la notification',
        example: false
    })
    is_read?: boolean;
}
