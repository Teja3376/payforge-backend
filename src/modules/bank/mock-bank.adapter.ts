import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BankPort } from './bank.port';

/**
 * In-memory bank used for local development and the test suite.
 *
 * It never performs I/O, so it cannot reproduce the failure modes that matter
 * most (timeouts, 5xx, duplicate webhooks) on its own — `createCharge` is
 * therefore given a small failure-injection hook so those paths can be
 * exercised deliberately rather than by luck.
 */
@Injectable()
export class MockBankAdapter implements BankPort {
  private readonly logger = new Logger(MockBankAdapter.name);

  /** Set by tests / dev tools to make the next N charges fail. */
  failNextCharges = 0;

  /** Simulated latency, used to prove the gateway timeout path. */
  chargeDelayMs = 0;

  async createCharge(input: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    paymentToken?: string;
    method: string;
  }): Promise<{ gatewayRef: string }> {
    if (this.chargeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.chargeDelayMs));
    }
    if (this.failNextCharges > 0) {
      this.failNextCharges -= 1;
      throw new Error('Mock bank declined the charge');
    }
    if (input.amountMinor <= 0n) {
      throw new Error('Mock bank refused a non-positive amount');
    }
    return { gatewayRef: `mock_${randomUUID().replace(/-/g, '')}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async voidCharge(input: { gatewayRef: string; reason: string }) {
    void input;
    this.logger.log('Voided mock charge');
    return { voided: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(_input: {
    gatewayRef: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }) {
    return { refundRef: `mock_refr_${randomUUID().replace(/-/g, '')}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createPayout(_input: {
    amountMinor: bigint;
    currency: string;
    destination: {
      bankName: string;
      accountHolder: string;
      accountNumber: string;
      routingNumber: string;
    };
    idempotencyKey: string;
  }) {
    return { externalRef: `mock_po_${randomUUID().replace(/-/g, '')}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createTokenizationSession(input: { clientSecret: string; expiresAt: Date }) {
    void input;
    return { sessionId: `mock_ts_${randomUUID().replace(/-/g, '')}` };
  }
}