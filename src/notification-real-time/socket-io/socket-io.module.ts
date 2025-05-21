import { Module } from "@nestjs/common";
import { PositionEventsGateway } from "./gateways/position-events.gateway";

@Module({
  imports: [],
  controllers: [],
  providers: [PositionEventsGateway],
})
export class SocketIoModule { }
