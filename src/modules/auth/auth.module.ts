import { Module } from '@nestjs/common';
import { AuthService } from 'src/modules/auth/services/auth.service';
import { AuthController } from 'src/modules/auth/controllers/auth.controller';
import { JwtStrategy } from 'src/modules/auth/strategies/jwt.strategy';
import { JwtRefreshStrategy } from 'src/modules/auth/strategies/jwt-refresh.strategy';
import { JsonWebTokenModule } from 'src/modules/auth/json-web-token/json-web-token.module';
import { OtpModule } from 'src/modules/auth/otp/otp.module';
import { JwtCustomerStrategy } from 'src/modules/auth/strategies/jwt-customer.strategy';

@Module({
  imports: [JsonWebTokenModule, OtpModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtRefreshStrategy, JwtCustomerStrategy],
})
export class AuthModule { }
