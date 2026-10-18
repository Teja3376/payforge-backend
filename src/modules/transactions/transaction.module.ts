import { Module } from '@nestjs/common';
import { BankModule } from '../bank/bank.module';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  imports: [BankModule],
  controllers: [TransactionController],
  providers: [TransactionService],
})
export class TransactionsModule {}
