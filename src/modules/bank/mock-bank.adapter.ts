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

  /**
   * Charge and refund outcomes, so `getChargeStatus` and `getRefundStatus` can
   * answer truthfully for references this adapter actually issued. A lookup for
   * anything else returns UNKNOWN rather than a fabricated answer.
   */
  private readonly charges = new Map<string, 'PENDING' | 'SUCCESS' | 'FAILED' | 'VOIDED'>();
  private readonly refunds = new Map<string, 'PENDING' | 'SUCCEEDED' | 'FAILED'>();
  private readonly refundsByCharge = new Set<string>();

  /** Test/dev hook: record how a charge should resolve. */
  setChargeOutcome(gatewayRef: string, status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'VOIDED') {
    this.charges.set(gatewayRef, status);
  }

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
    const gatewayRef = `mock_${randomUUID().replace(/-/g, '')}`;
    this.charges.set(gatewayRef, 'PENDING');
    return { gatewayRef };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async voidCharge(input: { gatewayRef: string; reason: string }) {
    void input;
    this.logger.log('Voided mock charge');
    this.charges.set(input.gatewayRef, 'VOIDED');
    return { voided: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(input: {
    gatewayRef: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }) {
    const refundRef = `mock_refr_${randomUUID().replace(/-/g, '')}`;
    this.refunds.set(refundRef, 'SUCCEEDED');
    this.refundsByCharge.add(input.gatewayRef);
    return { refundRef };
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

  /**
   * In-memory charge status.
   *
   * The mock records nothing, so a query for an unknown reference reports
   * UNKNOWN rather than guessing. That is deliberate: an adapter that reported
   * a confident answer for a charge it had never seen would let reconciliation
   * "resolve" a stranded transaction into a confidently wrong state.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getChargeStatus(input: { gatewayRef: string }) {
    if (!this.charges.has(input.gatewayRef)) {
      return { status: 'UNKNOWN' as const };
    }
    return { status: this.charges.get(input.gatewayRef)! };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getRefundStatus(input: { gatewayRef: string; refundRef?: string }) {
    if (input.refundRef && !this.refunds.has(input.refundRef)) {
      return { status: 'UNKNOWN' as const };
    }
    if (!input.refundRef && !this.refundsByCharge.has(input.gatewayRef)) {
      return { status: 'UNKNOWN' as const };
    }
    return { status: 'SUCCEEDED' as const };
  }
}