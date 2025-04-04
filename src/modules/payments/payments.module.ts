import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsService } from './services/payments.service';
import { MobileMoneyController } from './controllers/mobile-money.controller';
import { MobileMoneyService } from './services/mobile-money.service';
import { Payment } from './entities/payment.entity';
import { Transaction } from './entities/transaction.entity';
import { MobileMoneyTransaction } from './entities/mobile-money-transaction.entity';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Transaction, MobileMoneyTransaction]),
    AuthModule,
    OrdersModule,
  ],
  controllers: [PaymentsController, MobileMoneyController],
  providers: [PaymentsService, MobileMoneyService],
  exports: [PaymentsService, MobileMoneyService],
})
export class PaymentsModule {}