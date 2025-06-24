import { Module } from '@nestjs/common';
import { UsersService } from './services/users.service';
import { UsersController } from './controller/users.controller';
import { UserEvent } from './events/user.event';
import { UserEmailTemplates } from './templates/user-email.template';
import { UserListener } from './services/user-listener.service';
@Module({
  controllers: [UsersController],
  providers: [UsersService, UserListener, UserEvent, UserEmailTemplates],
})
export class UsersModule { }
