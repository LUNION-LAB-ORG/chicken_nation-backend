import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { AppGateway } from './gateways/app.gateway';
@Global()
@Module({
  imports: [ConfigModule, JsonWebTokenModule],
  providers: [
    AppGateway,
  ],
  exports: [
    AppGateway,
  ],
})
export class SocketIoModule { }