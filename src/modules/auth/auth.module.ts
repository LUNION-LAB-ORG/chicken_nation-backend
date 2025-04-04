import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';

import { User } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { Otp } from './entities/otp.entity';
import { AuthController } from './controllers/auth.controller';
import { AdminController } from './controllers/admin.controller';
import { AuthService } from './services/auth.service';
import { AdminService } from './services/admin.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    TypeOrmModule.forFeature([User, Role, Otp]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRATION') },
      }),
    }),
  ],
  controllers: [AuthController, AdminController],
  providers: [AuthService, AdminService, JwtStrategy],
  exports: [AuthService, JwtStrategy, PassportModule]
})
export class AuthModule {}