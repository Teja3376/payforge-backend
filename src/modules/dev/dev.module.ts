import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhook.module';
import { DevBankController } from './dev-bank.controller';

@Module({
  imports: [WebhooksModule],
  controllers: [DevBankController],
})
export class DevModule {}
