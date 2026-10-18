import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhook.module';
import { RefundController } from './refund.controller';
import { RefundService } from './refund.service';

@Module({
  imports: [WebhooksModule],
  controllers: [RefundController],
  providers: [RefundService],
})
export class RefundModule {}
