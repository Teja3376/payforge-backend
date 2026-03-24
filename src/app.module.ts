import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './database/prisma.service';
import { MerchantsModule } from './modules/merchants/merchant.module';
import { PaymentsModule } from './modules/payments/payment.module';
import { TransactionsModule } from './modules/transactions/transaction.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MerchantsModule,
    PaymentsModule,
    TransactionsModule,
  ],
  controllers: [],
  providers: [PrismaService],
})
export class AppModule {}
