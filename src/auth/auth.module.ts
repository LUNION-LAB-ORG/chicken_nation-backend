import { Module } from '@nestjs/common';
import { AuthService } from 'src/auth/services/auth.service';
import { AuthController } from 'src/auth/controllers/auth.controller';
import { JwtStrategy } from 'src/auth/strategies/jwt.strategy';
import { JwtRefreshStrategy } from 'src/auth/strategies/jwt-refresh.strategy';
import { DatabaseModule } from 'src/database/database.module';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { OtpModule } from 'src/otp/otp.module';

@Module({
  imports: [DatabaseModule, JsonWebTokenModule, OtpModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtRefreshStrategy],
})
export class AuthModule { }
