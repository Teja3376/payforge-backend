import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
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
  imports: [ScheduleModule.forRoot()],
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
          void dispatcher.deliverDue().catch(() => undefined);
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