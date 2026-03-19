import { PartialType } from '@nestjs/swagger';
import { CreateScheduledNotificationDto } from './create-scheduled-notification.dto';

export class UpdateScheduledNotificationDto extends PartialType(
  CreateScheduledNotificationDto,
) {}
