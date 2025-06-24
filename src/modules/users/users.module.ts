import { Module } from '@nestjs/common';
import { UsersService } from './services/users.service';
import { UsersController } from './controller/users.controller';
import { UserEvent } from './events/user.event';
import { UserEmailTemplates } from './templates/user-email.template';
import { UserListenerService } from './listeners/user-listener.service';
import { UserNotificationsTemplate } from './templates/user-notifications.template';
@Module({
  controllers: [UsersController],
  providers: [UsersService, UserListenerService, UserEvent, UserEmailTemplates, UserNotificationsTemplate],
})
export class UsersModule { }
