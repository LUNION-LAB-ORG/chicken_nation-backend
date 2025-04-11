import { Injectable } from '@nestjs/common';
import { CreateNotificationPreferenceDto,UpdateNotificationPreferenceDto } from '../dto/notification-preference.dto';

@Injectable()
export class NotificationPreferenceService {
  create(createNotificationPreferenceDto: CreateNotificationPreferenceDto) {
    return 'This action adds a new notificationPreference';
  }

  findAll() {
    return `This action returns all notificationPreference`;
  }

  findOne(id: number) {
    return `This action returns a #${id} notificationPreference`;
  }

  update(id: number, updateNotificationPreferenceDto: UpdateNotificationPreferenceDto) {
    return `This action updates a #${id} notificationPreference`;
  }

  remove(id: number) {
    return `This action removes a #${id} notificationPreference`;
  }
}
