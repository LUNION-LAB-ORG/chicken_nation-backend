import { Module } from '@nestjs/common';
import { CustomerService } from './services/customer.service';
import { CustomerController } from './controllers/customer.controller';
import { AddressController } from './controllers/address.controller';
import { FavoriteController } from './controllers/favorite.controller';
import { AddressService } from './services/address.service';
import { FavoriteService } from './services/favorite.service';

@Module({
  imports: [],
  controllers: [CustomerController, AddressController, FavoriteController],
  providers: [CustomerService, AddressService, FavoriteService],
})
export class CustomerModule { }
