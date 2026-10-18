import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyWebhook, WebhookBody } from '../bank/webhook-signature';
import { SettlementService } from './settlement.service';

@Injectable()
export class WebhookService {
  constructor(
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
  ) {}

  handle(body: WebhookBody, signature: string | undefined) {
    const secret = this.config.getOrThrow<string>('MOCK_BANK_SECRET');
    if (!verifyWebhook(body, signature, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return this.settlement.settle(body);
  }
}
