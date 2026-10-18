import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { decryptSecret } from '../../common/crypto/crypto';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

/** Rows claimed per sweep. Keeps one bad destination from stalling the queue. */
const BATCH_SIZE = 25;

/**
 * Drives scheduled payouts to completion at the bank.
 *
 * Before this existed, `POST /payouts` debited the merchant's balance, wrote a
 * lone ledger row, set the payout to SCHEDULED, and emitted `PAYOUT_PAID` —
 * and then nothing further happened. `markPaid` and `markFailed` were written
 * correctly but had no callers, and `BankPort.createPayout` was never invoked.
 * The merchant's money was destroyed in the ledger and reported as sent.
 *
 * This executor closes that loop. `markPaid`/`markFailed` remain the single
 * writers of payout state; this class only decides *when* to call them.
 */
@Injectable()
export class PayoutExecutor {
  private readonly log = new Logger(PayoutExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookDispatcher,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {}

  /**
   * Execute payouts that have been scheduled but not yet transferred.
   *
   * Claims rows with a compare-and-set from SCHEDULED to IN_TRANSIT so several
   * instances can run this concurrently without double-sending. IN_TRANSIT is
   * excluded from the sweep filter, so a process crash mid-transfer leaves a
   * visibly stuck row rather than silently re-sending money.
   */
  @Cron('*/1 * * * *', { timeZone: 'UTC' })
  async executeDue(): Promise<void> {
    const due = await this.prisma.payout.findMany({
      where: { status: 'SCHEDULED' },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const payout of due) {
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'SCHEDULED' },
        data: { status: 'IN_TRANSIT' },
      });
      if (claimed.count === 0) {
        continue; // another instance won the race
      }

      await this.executeOne(payout.id);
    }
  }

  private async executeOne(id: string): Promise<void> {
    const payout = await this.prisma.payout.findUniqueOrThrow({
      where: { id },
      include: { destination: true },
    });

    if (!payout.destination) {
      await this.markFailed(payout.publicId, 'Destination no longer exists');
      return;
    }

    try {
      // Decrypt only at the point of transfer. These values are never written
      // back to the database in plaintext and never logged.
      const accountNumber = decryptSecret(
        payout.destination.accountEnc,
        this.encryptionKey(),
      );
      const routingNumber = decryptSecret(
        payout.destination.routingEnc,
        this.encryptionKey(),
      );

      const external = await this.bank.createPayout({
        amountMinor: payout.amount,
        currency: payout.currency,
        destination: {
          bankName: payout.destination.bankName,
          accountHolder: payout.destination.accountHolder,
          accountNumber,
          routingNumber,
        },
        // Namespaced by payout id. The bank honours idempotencyKey, so two
        // merchants whose requests both used a generic key such as
        // "payout-1" would otherwise collide and one transfer would be
        // silently suppressed.
        idempotencyKey: `payout:${payout.publicId}`,
      });
      await this.markPaid(payout.publicId, external.externalRef);
    } catch (error) {
      this.log.error(
        { err: error, payoutId: payout.publicId },
        'payout execution failed at the bank',
      );
      // Returning the funds is the safe default: the merchant can retry, and
      // an operator can inspect a FAILED row. Leaving the balance debited
      // with no transfer is the behaviour this class exists to prevent.
      await this.markFailed(payout.publicId, 'Bank rejected the payout');
    }
  }

  private encryptionKey(): string {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      // validateEnv enforces this at boot; this guards a direct instantiation
      // in a test harness that bypassed the config module.
      throw new Error('ENCRYPTION_KEY is required to decrypt payout destinations');
    }
    return key;
  }

  private async markPaid(publicId: string, externalRef: string) {
    const updated = await this.prisma.payout.updateMany({
      where: { publicId, status: 'IN_TRANSIT' },
      data: { status: 'PAID', externalRef, processedAt: new Date(), failureReason: null },
    });
    if (updated.count === 0) {
      return;
    }

    const payout = await this.prisma.payout.findUniqueOrThrow({ where: { publicId } });
    await this.webhooks.dispatchPayoutEvent({ payoutId: payout.id, type: 'PAYOUT_PAID' });
  }

  /**
   * Reverse the balance debit taken at schedule time and post the compensating
   * ledger pair, so a failed payout cannot leave the merchant short.
   */
  private async markFailed(publicId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({
        where: { publicId, status: { in: ['SCHEDULED', 'IN_TRANSIT'] } },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500), processedAt: new Date() },
      });
      if (claimed.count === 0) {
        return;
      }

      const payout = await tx.payout.findUniqueOrThrow({ where: { publicId } });

      // Lock first so a concurrent sweep cannot interleave the read and the
      // increment. applyBalance in the settlement service does the same.
      await tx.$queryRaw`
        SELECT "id" FROM "MerchantBalance"
        WHERE "merchantId" = ${payout.merchantId} AND "currency" = ${payout.currency}
        FOR UPDATE
      `;

      await tx.merchantBalance.upsert({
        where: { merchantId_currency: { merchantId: payout.merchantId, currency: payout.currency } },
        create: { merchantId: payout.merchantId, currency: payout.currency, balance: payout.amount },
        update: { balance: { increment: payout.amount } },
      });

      const referenceId = `payout-reversal:${payout.publicId}`;
      await tx.ledgers.createMany({
        data: [
          {
            publicId: generatePublicId('pf-ledger'),
            account: 'MERCHANT',
            accountKey: payout.merchantId,
            merchantId: payout.merchantId,
            currency: payout.currency,
            amount: payout.amount,
            type: 'CREDIT',
            referenceId,
          },
          {
            publicId: generatePublicId('pf-ledger'),
            account: 'MERCHANT_CLEARING',
            accountKey: payout.merchantId,
            merchantId: payout.merchantId,
            currency: payout.currency,
            amount: payout.amount,
            type: 'DEBIT',
            referenceId,
          },
        ],
      });
    });

    const payout = await this.prisma.payout.findUniqueOrThrow({ where: { publicId } });
    await this.webhooks.dispatchPayoutEvent({ payoutId: payout.id, type: 'PAYOUT_FAILED' });
  }

  /**
   * Recover payouts stranded in IN_TRANSIT by a process crash.
   *
   * The claim step moves SCHEDULED to IN_TRANSIT before the bank call, so a
   * pod eviction mid-transfer leaves a row that no longer matches the sweep's
   * filter. Without this sweep those transfers are silently abandoned.
   */
  @Cron('*/5 * * * *', { timeZone: 'UTC' })
  async recoverStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - 15 * 60_000);
    const stuck = await this.prisma.payout.findMany({
      where: { status: 'IN_TRANSIT', updatedAt: { lt: cutoff } },
      take: BATCH_SIZE,
      select: { id: true, publicId: true },
    });

    for (const payout of stuck) {
      this.log.error(
        { payoutId: payout.publicId },
        'payout stuck IN_TRANSIT past the recovery window — requires manual review',
      );
      await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'IN_TRANSIT' },
        data: { failureReason: 'Transfer status unknown; manual review required' },
      });
    }
  }
}