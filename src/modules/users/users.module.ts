import { Module } from '@nestjs/common';
import { UsersService } from './services/users.service';
import { UserPushService } from './services/user-push.service';
import { UsersController } from './controller/users.controller';
import { UserEvent } from './events/user.event';
import { UserListenerService } from './listeners/user-listener.service';
import { UserNotificationsTemplate } from './templates/user-notifications.template';

@Module({
  // ExpoPushModule est @Global() → pas besoin de l'importer ici.
  controllers: [UsersController],
  providers: [
    UsersService,
    UserPushService,
    UserListenerService,
    UserEvent,
    UserNotificationsTemplate,
  ],
  exports: [UserPushService],
})
export class UsersModule {}
