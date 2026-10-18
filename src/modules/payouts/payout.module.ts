import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BankModule } from '../bank/bank.module';
import { WebhooksModule } from '../webhooks/webhook.module';
import { PayoutController } from './payout.controller';
import { PayoutExecutor } from './payout-executor.service';
import { PayoutService } from './payout.service';

@Module({
  // ScheduleModule.forRoot is only called in AppModule; importing the module
  // here gives PayoutExecutor access to the shared SchedulerRegistry without
  // re-initialising it. Calling forRoot twice registers the cron job twice and
  // throws DUPLICATE_SCHEDULER on the second registration.
  imports: [ScheduleModule, BankModule, WebhooksModule],
  controllers: [PayoutController],
  providers: [PayoutService, PayoutExecutor],
  exports: [PayoutService],
})
export class PayoutModule {}
