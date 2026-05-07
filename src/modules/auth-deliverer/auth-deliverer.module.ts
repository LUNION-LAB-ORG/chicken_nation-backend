import { Module } from '@nestjs/common';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { OtpModule } from 'src/modules/auth/otp/otp.module';

import { AuthDelivererController } from './controllers/auth-deliverer.controller';
import { DelivererOperationalGuard } from './guards/deliverer-operational.guard';
import { JwtDelivererAuthGuard } from './guards/jwt-deliverer-auth.guard';
import { JwtDelivererRefreshAuthGuard } from './guards/jwt-deliverer-refresh-auth.guard';
import { AuthDelivererService } from './services/auth-deliverer.service';
import { JwtDelivererRefreshStrategy } from './strategies/jwt-deliverer-refresh.strategy';
import { JwtDelivererStrategy } from './strategies/jwt-deliverer.strategy';

@Module({
  imports: [JsonWebTokenModule, OtpModule],
  controllers: [AuthDelivererController],
  providers: [
    AuthDelivererService,
    JwtDelivererStrategy,
    JwtDelivererRefreshStrategy,
    JwtDelivererAuthGuard,
    JwtDelivererRefreshAuthGuard,
    DelivererOperationalGuard,
  ],
  exports: [
    AuthDelivererService,
    JwtDelivererAuthGuard,
    JwtDelivererRefreshAuthGuard,
    DelivererOperationalGuard,
  ],
})
export class AuthDelivererModule {}
