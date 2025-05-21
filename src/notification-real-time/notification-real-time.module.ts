import { Module } from "@nestjs/common";
import { EmailModule } from "./email/email.module";
import { SocketIoModule } from "./socket-io/socket-io.module";
import { TwilioModule } from "./twilio/twilio.module";

@Module({
  imports: [EmailModule, SocketIoModule, TwilioModule],
  controllers: [],
  providers: [],
})
export class NotificationRealTimeModule { }
