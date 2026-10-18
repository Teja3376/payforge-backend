import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { WebhooksModule } from '../webhooks/webhook.module';

@Module({
  imports: [WebhooksModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}