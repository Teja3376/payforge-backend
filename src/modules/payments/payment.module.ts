import { Module } from '@nestjs/common';
import { BankModule } from '../bank/bank.module';
import { FxModule } from '../fx/fx.module';
import { ClientSessionService } from './client-session.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [FxModule, BankModule],
  controllers: [PaymentController],
  providers: [PaymentService, ClientSessionService],
  exports: [PaymentService, ClientSessionService],
})
export class PaymentModule {}
