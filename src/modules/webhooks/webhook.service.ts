import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { verifyWebhook, type WebhookBody } from '../bank/webhook-signature';
import { SettlementService } from './settlement.service';

@Injectable()
export class WebhookService {
  constructor(
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Verify and apply an inbound bank callback.
   *
   * Uses `BANK_WEBHOOK_SECRET`, distinct from the mock bank's signing key. The
   * original shared one secret between production verification and the dev
   * signing helper, so anyone who could reach the dev endpoint held the
   * production credential.
   */
  async handle(body: WebhookBody, signature: string | undefined) {
    const secret = this.config.getOrThrow<string>('BANK_WEBHOOK_SECRET');

    const result = verifyWebhook(body, signature, secret);
    if (!result.valid) {
      throw ApiError.of(ErrorCode.INVALID_WEBHOOK_SIGNATURE, 'Invalid webhook signature.');
    }

    return this.settlement.settle(body);
  }
}
