import { Module } from '@nestjs/common';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { OtpModule } from './otp/otp.module';
import { JwtCustomerStrategy } from './strategies/jwt-customer.strategy';

@Module({
  imports: [JsonWebTokenModule, OtpModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtRefreshStrategy, JwtCustomerStrategy],
})
export class AuthModule { }
