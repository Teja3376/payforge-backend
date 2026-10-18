import { Module } from '@nestjs/common';
import { BankModule } from '../bank/bank.module';
import { WebhooksModule } from '../webhooks/webhook.module';
import { PayoutController } from './payout.controller';
import { PayoutService } from './payout.service';

@Module({
  imports: [BankModule, WebhooksModule],
  controllers: [PayoutController],
  providers: [PayoutService],
})
export class PayoutModule {}
