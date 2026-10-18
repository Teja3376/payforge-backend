import { Logger, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BankModule } from '../bank/bank.module';
import { WebhookController } from './webhook.controller';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookDispatcher } from './webhook-dispatcher.service';
import { WebhookService } from './webhook.service';
import { SettlementService } from './settlement.service';

/**
 * Retry sweep for outbound webhook deliveries.
 *
 * Runs every minute and claims rows with a compare-and-set, so running
 * multiple replicas is safe: the first to claim a row owns that delivery and
 * the others find nothing to do.
 */
@Module({
  // Plain ScheduleModule, not forRoot(). AppModule already calls forRoot();
  // calling it again re-registers the explorer and SchedulerRegistry.addCronJob
  // throws DUPLICATE_SCHEDULER on the second registration of any cron.
  // BankModule supplies BANK_PORT for SettlementService, which now calls
  // BankPort.refund. Previously refunds moved only the internal ledger, so the
  // cardholder was never actually credited back and the merchant absorbed it.
  imports: [ScheduleModule, BankModule],
  controllers: [WebhookController],
  providers: [
    WebhookDispatcher,
    WebhookEndpointService,
    WebhookService,
    SettlementService,
    {
      provide: 'WEBHOOK_SWEEP',
      useFactory: (dispatcher: WebhookDispatcher) => {
        const timer = setInterval(() => {
          // Previously `.catch(() => undefined)` — a database outage during a
          // sweep produced no log output at all. Surface it.
          void dispatcher.deliverDue().catch((error: unknown) => {
            Logger.error(`webhook sweep failed: ${String(error)}`, 'WEBHOOK_SWEEP');
          });
        }, 60_000);
        // Do not hold the event loop open purely for the sweep.
        timer.unref();
        return timer;
      },
      inject: [WebhookDispatcher],
    },
  ],
  exports: [SettlementService, WebhookDispatcher, WebhookEndpointService, WebhookService],
})
export class WebhooksModule {}