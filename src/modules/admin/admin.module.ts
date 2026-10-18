import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhook.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [WebhooksModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
