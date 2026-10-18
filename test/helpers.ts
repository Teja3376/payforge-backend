import type { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './database';

/**
 * Truncate every table between scenarios.
 *
 * A payment suite that shares state cannot assert on balances, because a
 * previous scenario's money is still in the account. `TRUNCATE ... CASCADE`
 * is used rather than deletes so the append-only trigger does not fire.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Resolution", "WebhookDelivery", "WebhookEndpoint", "ClientSession",
      "SavedPaymentMethod", "Refund", "Payout", "PayoutDestination",
      "Ledgers", "MerchantBalance", "PlatformAccount", "Transactions",
      "Payments", "ApiKey", "Session", "LoginAttempt", "Users",
      "MerchantFeeSchedule", "MerchantKyc", "MerchantRisk",
      "MerchantProviderAccount", "Merchants", "ExchangeRateSnapshot"
    RESTART IDENTITY CASCADE
  `);
}

export { TEST_DATABASE_URL };

/** Build a Prisma client pointed at the integration database. */
export function makePrisma(): PrismaClient {
  // Required at module load; the global setup has already run by the time any
  // test file is imported.
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
    log: [],
  });
}

/**
 * A bank adapter that records every call, so a test can prove a retry did not
 * reach the provider a second time.
 *
 * Counting provider calls is the only way to distinguish "the request was
 * replayed safely" from "the request was deduplicated at the database but the
 * provider was charged twice". The second is the failure mode that actually
 * loses a customer's money.
 */
export class CountingBankAdapter {
  chargeCalls: Array<{ amountMinor: bigint; currency: string; idempotencyKey: string }> = [];
  refundCalls: Array<{ gatewayRef: string; amountMinor: bigint; idempotencyKey: string }> = [];
  payoutCalls: Array<{ amountMinor: bigint; idempotencyKey: string }> = [];
  voidCalls: Array<{ gatewayRef: string }> = [];

  failNextCharges = 0;
  failNextPayouts = 0;
  failNextRefunds = 0;

  /** Set to make the next N payout calls throw, exercising the retry path. */
  chargeDelayMs = 0;

  reset(): void {
    this.chargeCalls = [];
    this.refundCalls = [];
    this.payoutCalls = [];
    this.voidCalls = [];
    this.failNextCharges = 0;
    this.failNextPayouts = 0;
    this.failNextRefunds = 0;
    this.chargeDelayMs = 0;
  }

  /** Charges actually issued to the provider. Must equal 1 per settled payment. */
  get chargeCount(): number {
    return this.chargeCalls.length;
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
      throw new Error('bank declined');
    }
    this.chargeCalls.push({
      amountMinor: input.amountMinor,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
    });
    return { gatewayRef: `it_${this.chargeCalls.length}` };
  }

  async voidCharge(input: { gatewayRef: string; reason: string }) {
    this.voidCalls.push({ gatewayRef: input.gatewayRef });
    return { voided: true };
  }

  async refund(input: {
    gatewayRef: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }) {
    if (this.failNextRefunds > 0) {
      this.failNextRefunds -= 1;
      throw new Error('bank refused refund');
    }
    this.refundCalls.push({
      gatewayRef: input.gatewayRef,
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
    });
    return { refundRef: `it_refr_${this.refundCalls.length}` };
  }

  async createPayout(input: {
    amountMinor: bigint;
    currency: string;
    destination: unknown;
    idempotencyKey: string;
  }) {
    if (this.failNextPayouts > 0) {
      this.failNextPayouts -= 1;
      throw new Error('bank rejected payout');
    }
    this.payoutCalls.push({
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
    });
    return { externalRef: `it_po_${this.payoutCalls.length}` };
  }

  async createTokenizationSession() {
    return { sessionId: 'it_ts_1' };
  }

  async getChargeStatus(input: { gatewayRef: string }) {
    return { status: 'UNKNOWN' as const };
  }

  async getRefundStatus() {
    return { status: 'UNKNOWN' as const };
  }
}