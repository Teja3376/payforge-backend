import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  controllers: [WebhookController],
  providers: [SettlementService, WebhookService],
  exports: [SettlementService, WebhookService],
})
export class WebhooksModule {}
