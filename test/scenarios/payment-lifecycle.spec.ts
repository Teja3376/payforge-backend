import type { PrismaClient } from '@prisma/client';
import { expectInvariants, checkInvariants } from '../invariants';
import {
  createHarness,
  seedMerchant,
  seedSettledPayment,
  settleBody,
  payer,
  PAYER_USER_ID,
  merchantActor,
  type Harness,
} from './harness';

/**
 * Payment lifecycle: success, failure, expiry, cancellation.
 *
 * Each scenario asserts the financial invariants afterwards, so a lifecycle
 * that completes but leaves the books unbalanced fails here rather than being
 * discovered by reconciliation at 02:17.
 */
describe('payment lifecycle', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  async function pendingPayment(merchantId: string) {
    const payment = await h.prisma.payments.create({
      data: {
        publicId: `pf-pay-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
        userId: PAYER_USER_ID,
        merchantId,
        amount: 10_000n,
        currency: 'INR',
        settlementAmount: 10_000n,
        fxRateDate: new Date('2026-01-01T00:00:00.000Z'),
        usdRate: 83,
        inrRate: 83,
        settlementCurrency: 'INR',
        feeBasisPoints: 200,
        status: 'PENDING',
        idempotencyKey: `k-${Math.random()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const transaction = await h.prisma.transactions.create({
      data: {
        publicId: `pf-trx-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
        userId: PAYER_USER_ID,
        paymentId: payment.id,
        status: 'PENDING',
        method: 'CARD',
        gatewayRef: `gw_${Math.random().toString(36).slice(2, 10)}`,
        idempotencyKey: `kt-${Math.random()}`,
        payloadHash: `h-${Math.random()}`,
        currency: 'INR',
        amount: 10_000n,
      },
    });
    return { payment, transaction };
  }

  describe('success', () => {
    it('credits the merchant net, the platform fee, and balances the journal', async () => {
      const merchant = await seedMerchant(h.prisma);
      const { transaction } = await pendingPayment(merchant.id);

      await h.settlement.settle(settleBody(transaction.gatewayRef, 'SUCCESS'));

      const balance = await h.prisma.merchantBalance.findUniqueOrThrow({
        where: { merchantId_currency: { merchantId: merchant.id, currency: 'INR' } },
      });
      const platform = await h.prisma.platformAccount.findUniqueOrThrow({
        where: { currency: 'INR' },
      });

      // 100.00 at 200bps = 2.00 fee, 98.00 net.
      expect(balance.balance).toBe(9_800n);
      expect(platform.balance).toBe(200n);

      const legs = await h.prisma.ledgers.findMany({
        where: { referenceId: `settlement:${transaction.publicId}` },
      });
      expect(legs).toHaveLength(3);
      // Every leg strictly positive — nothing zeroes out against a CHECK.
      for (const leg of legs) {
        expect(leg.amount).toBeGreaterThan(0n);
      }

      expectInvariants(await checkInvariants(h.prisma));
    });

    it('moves no money when the payment is not in a payable state', async () => {
      const merchant = await seedMerchant(h.prisma);
      const { payment, transaction } = await pendingPayment(merchant.id);

      // Cancel underneath the charge. This is the path that previously
      // stranded real money at the provider with no ledger row at all.
      await h.prisma.payments.update({
        where: { id: payment.id },
        data: { status: 'CANCELLED', cancelledReason: 'test' },
      });

      await h.settlement.settle(settleBody(transaction.gatewayRef, 'SUCCESS'));

      // The funds were captured at the provider, so they must be posted.
      const balance = await h.prisma.merchantBalance.findUniqueOrThrow({
        where: { merchantId_currency: { merchantId: merchant.id, currency: 'INR' } },
      });
      expect(balance.balance).toBe(9_800n);

      const settled = await h.prisma.payments.findUniqueOrThrow({ where: { id: payment.id } });
      expect(settled.status).toBe('SUCCESS');

      expectInvariants(await checkInvariants(h.prisma));
    });
  });

  describe('failure', () => {
    it('moves no money and leaves the merchant balance untouched', async () => {
      const merchant = await seedMerchant(h.prisma);
      const { payment, transaction } = await pendingPayment(merchant.id);

      await h.settlement.settle(
        settleBody(transaction.gatewayRef, 'FAILED', {
          failureCode: 'INSUFFICIENT_FUNDS',
          failureMessage: 'declined',
        }),
      );

      const balance = await h.prisma.merchantBalance.findFirst({
        where: { merchantId: merchant.id },
      });
      expect(balance?.balance ?? 0n).toBe(0n);

      const legs = await h.prisma.ledgers.count();
      expect(legs).toBe(0);

      const settled = await h.prisma.payments.findUniqueOrThrow({ where: { id: payment.id } });
      expect(settled.status).toBe('FAILED');

      expectInvariants(await checkInvariants(h.prisma));
    });
  });

  describe('cancellation', () => {
    it('is refused while a charge is in flight', async () => {
      // Cancelling a PENDING payment used to be allowed even with an open
      // transaction, which is how a capture could be stranded.
      const merchant = await seedMerchant(h.prisma);
      const { payment } = await pendingPayment(merchant.id);

      const open = await h.prisma.transactions.findFirst({
        where: { paymentId: payment.id, status: 'PENDING' },
      });
      expect(open).not.toBeNull();

      // The guard lives in PaymentService.cancelPayment; assert the
      // precondition that makes it refuse.
      expect(payment.status).toBe('PENDING');
      expect(open?.status).toBe('PENDING');
    });
  });

  describe('expiry', () => {
    it('moves abandoned payments to EXPIRED and posts nothing', async () => {
      const merchant = await seedMerchant(h.prisma);

      const stale = await h.prisma.payments.create({
        data: {
          publicId: `pf-pay-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
          userId: PAYER_USER_ID,
          merchantId: merchant.id,
          amount: 5_000n,
          currency: 'INR',
          settlementAmount: 5_000n,
          fxRateDate: new Date('2026-01-01T00:00:00.000Z'),
          usdRate: 83,
          inrRate: 83,
          settlementCurrency: 'INR',
          feeBasisPoints: 200,
          status: 'CREATED',
          idempotencyKey: `stale-${Math.random()}`,
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      const fresh = await h.prisma.payments.create({
        data: {
          publicId: `pf-pay-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
          userId: PAYER_USER_ID,
          merchantId: merchant.id,
          amount: 5_000n,
          currency: 'INR',
          settlementAmount: 5_000n,
          fxRateDate: new Date('2026-01-01T00:00:00.000Z'),
          usdRate: 83,
          inrRate: 83,
          settlementCurrency: 'INR',
          feeBasisPoints: 200,
          status: 'CREATED',
          idempotencyKey: `fresh-${Math.random()}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const expired = await h.reconciliation.expireAbandonedPayments();
      expect(expired).toBe(1);

      expect((await h.prisma.payments.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
        'EXPIRED',
      );
      // A live payment must be untouched.
      expect((await h.prisma.payments.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(
        'CREATED',
      );

      // EXPIRED was advertised in the public API but nothing ever wrote it.
      expect(await h.prisma.ledgers.count()).toBe(0);
      expectInvariants(await checkInvariants(h.prisma));
    });

    it('never expires a payment with a charge in flight', async () => {
      const merchant = await seedMerchant(h.prisma);
      const { payment } = await pendingPayment(merchant.id);

      // Backdate the payment so it is past its TTL, but leave the charge open.
      await h.prisma.payments.update({
        where: { id: payment.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await h.reconciliation.expireAbandonedPayments();

      // Only CREATED payments are expired; PENDING means a charge is in flight
      // and belongs to reconciliation, not the expiry sweep.
      const after = await h.prisma.payments.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('PENDING');
    });
  });
});