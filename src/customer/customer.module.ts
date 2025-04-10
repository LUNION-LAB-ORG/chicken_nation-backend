import { Module } from '@nestjs/common';
import { CustomerService } from './services/customer.service';
import { CustomerController } from './controllers/customer.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from 'src/customer/entities/customer.entity';
import { Favorite } from 'src/customer/entities/favorite.entity';
import { Address } from 'src/customer/entities/address.entity';
import { OtpToken } from 'src/auth/entities/otp-token.entity';
import { NotificationPreference } from 'src/notifications/entities/notification-preference.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, Favorite, Address, OtpToken, NotificationPreference])],
  controllers: [CustomerController],
  providers: [CustomerService],
})
export class CustomerModule { }
