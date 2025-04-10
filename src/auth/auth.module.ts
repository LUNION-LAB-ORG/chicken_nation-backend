import { Module } from '@nestjs/common';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { CommonModule } from 'src/common/common.module';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OtpToken } from 'src/auth/entities/otp-token.entity';
import { CounterOtp } from 'src/auth/entities/counter-otp.entity';
import { Customer } from 'src/customer/entities/customer.entity';

@Module({
  imports: [CommonModule, JwtModule.register({}), TypeOrmModule.forFeature([OtpToken, CounterOtp, Customer])],
  controllers: [AuthController],
  providers: [AuthService, JwtService, JwtStrategy, JwtRefreshStrategy],
})
export class AuthModule { }
