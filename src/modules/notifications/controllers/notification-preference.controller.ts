import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { NotificationPreferenceService } from '../services/notification-preference.service';
import { CreateNotificationPreferenceDto,UpdateNotificationPreferenceDto } from '../dto/notification-preference.dto';

@Controller('notification-preference')
export class NotificationPreferenceController {
  constructor(private readonly notificationPreferenceService: NotificationPreferenceService) {}

  @Post()
  create(@Body() createNotificationPreferenceDto: CreateNotificationPreferenceDto) {
    return this.notificationPreferenceService.create(createNotificationPreferenceDto);
  }

  @Get()
  findAll() {
    return this.notificationPreferenceService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.notificationPreferenceService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateNotificationPreferenceDto: UpdateNotificationPreferenceDto) {
    return this.notificationPreferenceService.update(+id, updateNotificationPreferenceDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.notificationPreferenceService.remove(+id);
  }
}
