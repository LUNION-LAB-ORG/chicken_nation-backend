import { Module } from '@nestjs/common';
import { CustomerService } from './services/customer.service';
import { CustomerController } from './controllers/customer.controller';
import { AddressController } from './controllers/address.controller';
import { FavoriteController } from './controllers/favorite.controller';
import { AddressService } from './services/address.service';
import { FavoriteService } from './services/favorite.service';
import { CommentController } from './controllers/comment.controller';
import { CommentService } from './services/comment.service';
import { CustomerEvent } from './events/customer.event';
// import { CustomerListenerService } from './listeners/customer-listener.service';

@Module({
  imports: [],
  controllers: [
    CustomerController,
    AddressController,
    FavoriteController,
    CommentController
  ],
  providers: [
    CustomerService,
    AddressService,
    FavoriteService,
    CommentService,
    CustomerEvent,
    // CustomerListenerService
  ],
})
export class CustomerModule { }
