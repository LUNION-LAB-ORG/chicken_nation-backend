import { Module } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';

@Module({
  imports: [JwtModule.register({})],
  providers: [JwtService, JsonWebTokenService],
  exports: [JsonWebTokenService],
})
export class JsonWebTokenModule { }
