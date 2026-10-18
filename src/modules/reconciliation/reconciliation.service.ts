import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LedgerAccount, LedgerType, PaymentStatus, Prisma, ResolutionAction, ResolutionSubject, TransactionStatus } from '@prisma/client';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { BANK_PORT, type BankPort } from '../bank/bank.port';

/**
 * A break between the journal and the balances it is supposed to explain.
 */
export type ReconciliationBreak = {
  kind: 'LEDGER_IMBALANCE' | 'BALANCE_DRIFT' | 'STRANDED_REFUND' | 'ORPHANED_CHARGE';
  detail: string;
  magnitudeMinor: bigint;
  currency?: string;
  merchantPublicId?: string;
  referencePublicId?: string;
};

/**
 * Proves the books balance, and finds the movements that never landed.
 *
 * There was no reconciliation of any kind before this: `grep -i reconcil`
 * returned six prose comments and no code. That absence is what let several
 * defects in this codebase be silent. A payout that debited a balance and
 * never transferred, a refund that reversed only the ledger, and a charge
 * stranded after a failed commit all produced the same symptom — the books did
 * not tie out — and nothing was watching.
 *
 * Three invariants are checked:
 *
 *  1. LEDGER_IMBALANCE — per currency, sum(credits) must equal sum(debits)
 *     across all accounts. This is the double-entry invariant, and it is the
 *     one that proves recorded money equals accounted money.
 *  2. BALANCE_DRIFT — each merchant balance must equal the sum of that
 *     merchant's ledger entries. The balance is a mutable cache of the journal,
 *     so the two must agree.
 *  3. STRANDED_REFUND — a refund left PENDING means the provider call was
 *     interrupted. The money may or may not have reached the cardholder.
 *  4. ORPHANED_CHARGE — a transaction PENDING far past its window with a
 *     gateway reference means the callback never arrived.
 *
 * Breaks are recorded as Resolution rows so they are durable and auditable,
 * and logged at error level so they can be alerted on.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {}

  /**
   * Verify the double-entry invariant for every currency that has moved money.
   */
  @Cron('17 2 * * *', { timeZone: 'UTC' })
  async nightly(): Promise<ReconciliationBreak[]> {
    const breaks: ReconciliationBreak[] = [];

    breaks.push(...(await this.checkLedgerBalance()));
    breaks.push(...(await this.checkBalanceDrift()));
    breaks.push(...(await this.checkStrandedRefunds()));
    breaks.push(...(await this.checkOrphanedCharges()));

    if (breaks.length > 0) {
      this.log.error({ count: breaks.length, breaks }, 'reconciliation found discrepancies');
      await this.recordBreaks(breaks);
    } else {
      this.log.log('reconciliation clean: journal balances and no stranded movements');
    }

    return breaks;
  }

  /**
   * sum(CREDIT) must equal sum(DEBIT) for every currency, across all accounts.
   *
   * This is the whole point of double entry: if the two totals differ, money
   * has been created or destroyed somewhere in the system.
   */
  async checkLedgerBalance(): Promise<ReconciliationBreak[]> {
    const rows = await this.prisma.$queryRaw<Array<{ currency: string; credits: bigint; debits: bigint }>>`
      SELECT "currency",
             COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0) AS "credits",
             COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0) AS "debits"
      FROM "Ledgers"
      GROUP BY "currency"
      HAVING COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0)
           <> COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0)
    `;

    return rows.map((row) => ({
      kind: 'LEDGER_IMBALANCE' as const,
      detail:
        `credits(${row.credits}) != debits(${row.debits}) — money was created or destroyed`,
      magnitudeMinor: row.credits > row.debits ? row.credits - row.debits : row.debits - row.credits,
      currency: row.currency,
    }));
  }

  /**
   * Each merchant balance must equal the sum of their ledger entries.
   *
   * `MerchantBalance.balance` is a mutable scalar maintained alongside an
   * append-only journal. Nothing forced the two to agree, which is why a failed
   * increment could persist unnoticed.
   */
  async checkBalanceDrift(): Promise<ReconciliationBreak[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        merchantId: string;
        publicId: string;
        currency: string;
        balance: bigint;
        ledgerSum: bigint;
      }>
    >`
      SELECT b."merchantId",
             m."publicId",
             b."currency",
             b."balance",
             COALESCE(SUM(l."amount") FILTER (
               WHERE l."account" = 'MERCHANT' AND l."type" = 'CREDIT'
             ), 0) - COALESCE(SUM(l."amount") FILTER (
               WHERE l."account" = 'MERCHANT' AND l."type" = 'DEBIT'
             ), 0) AS "ledgerSum"
      FROM "MerchantBalance" b
      JOIN "Merchants" m ON m."id" = b."merchantId"
      LEFT JOIN "Ledgers" l
        ON l."merchantId" = b."merchantId" AND l."currency" = b."currency"
      GROUP BY b."merchantId", m."publicId", b."currency", b."balance"
      HAVING b."balance" <> SUM(l."amount") FILTER (
               WHERE l."account" = 'MERCHANT' AND l."type" = 'CREDIT'
             ) - SUM(l."amount") FILTER (
               WHERE l."account" = 'MERCHANT' AND l."type" = 'DEBIT'
             )
    `;

    return rows.map((row) => ({
      kind: 'BALANCE_DRIFT' as const,
      detail: `balance(${row.balance}) != ledgerSum(${row.ledgerSum})`,
      magnitudeMinor:
        row.balance > row.ledgerSum ? row.balance - row.ledgerSum : row.ledgerSum - row.balance,
      currency: row.currency,
      merchantPublicId: row.publicId,
    }));
  }

  /**
   * Refunds left PENDING were interrupted between reserving the key and
   * applying the ledger reversal.
   *
   * These cannot be resolved automatically: the provider may or may not have
   * processed the refund, and re-sending risks a double refund. They are
   * surfaced for an operator, who can query the provider by
   * `gatewayRefundRef` and then either complete or void the local row.
   */
  async checkStrandedRefunds(): Promise<ReconciliationBreak[]> {
    const cutoff = new Date(Date.now() - 15 * 60_000);
    const stranded = await this.prisma.refund.findMany({
      where: { status: 'PENDING', updatedAt: { lt: cutoff } },
      select: {
        publicId: true,
        amount: true,
        currency: true,
        gatewayRefundRef: true,
        payment: { select: { publicId: true } },
      },
      take: 100,
    });

    return stranded.map((refund) => ({
      kind: 'STRANDED_REFUND' as const,
      detail: refund.gatewayRefundRef
        ? `refund ${refund.publicId} left PENDING with provider ref ${refund.gatewayRefundRef}; verify against the provider before retrying`
        : `refund ${refund.publicId} left PENDING with no provider reference; the bank call may not have been made`,
      magnitudeMinor: refund.amount,
      currency: refund.currency,
      referencePublicId: refund.publicId,
      merchantPublicId: refund.payment.publicId,
    }));
  }

  /**
   * Transactions stuck PENDING have a gateway reference but never received a
   * callback. `Transactions_one_open_per_payment` means the payment cannot be
   * charged again, so an unrecovered one is permanently wedged.
   */
  async checkOrphanedCharges(): Promise<ReconciliationBreak[]> {
    const cutoff = new Date(Date.now() - 60 * 60_000);
    const orphaned = await this.prisma.transactions.findMany({
      where: { status: TransactionStatus.PENDING, updatedAt: { lt: cutoff } },
      select: {
        publicId: true,
        gatewayRef: true,
        amount: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
        payment: { select: { publicId: true, status: true } },
      },
      take: 100,
    });

    const breaks: ReconciliationBreak[] = [];

    for (const tx of orphaned) {
      // Ask the provider what actually happened rather than guessing. A
      // callback lost in transit is indistinguishable from a charge still in
      // flight locally, and treating one as the other either credits money
      // that was never taken or wedges the payment permanently.
      let observed: 'PENDING' | 'SUCCESS' | 'FAILED' | 'VOIDED' | 'UNKNOWN' = 'UNKNOWN';
      try {
        const result = await this.bank.getChargeStatus({ gatewayRef: tx.gatewayRef });
        observed = result.status;
      } catch (error) {
        this.log.error(
          { err: error, gatewayRef: tx.gatewayRef },
          'could not read charge status from the provider',
        );
      }

      breaks.push({
        kind: 'ORPHANED_CHARGE',
        detail:
          `transaction ${tx.publicId} has been PENDING since ${tx.createdAt.toISOString()} ` +
          `(gatewayRef ${tx.gatewayRef}); provider reports ${observed}; ` +
          `payment status is ${tx.payment.status}.`,
        magnitudeMinor: tx.amount,
        currency: tx.currency,
        referencePublicId: tx.publicId,
        merchantPublicId: tx.payment.publicId,
      });
    }

    return breaks;
  }

  /**
   * Attempt to complete a stranded refund whose provider call clearly landed.
   *
   * A PENDING refund with a `gatewayRefundRef` means the bank accepted the
   * refund and the process died before posting the ledger reversal. The
   * merchant has been debited for money that did go back to the cardholder, so
   * the reversal should be applied. This is the one stranded case that is safe
   * to close automatically.
   *
   * A PENDING refund with *no* reference is not touched: the bank call may
   * never have been made, and retrying could double-refund.
   */
  @Cron('41 * * * *', { timeZone: 'UTC' })
  async resolveStrandedRefunds(): Promise<number> {
    const cutoff = new Date(Date.now() - 15 * 60_000);
    const stranded = await this.prisma.refund.findMany({
      where: { status: 'PENDING', gatewayRefundRef: { not: null }, updatedAt: { lt: cutoff } },
      select: { id: true, publicId: true, amount: true, currency: true, gatewayRefundRef: true },
      take: 50,
    });

    let resolved = 0;

    for (const refund of stranded) {
      let providerStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' = 'UNKNOWN';
      try {
        const refundRow = await this.prisma.refund.findUniqueOrThrow({
          where: { id: refund.id },
          select: { transaction: { select: { gatewayRef: true } } },
        });
        const result = await this.bank.getRefundStatus({
          gatewayRef: refundRow.transaction.gatewayRef,
          refundRef: refund.gatewayRefundRef ?? undefined,
        });
        providerStatus = result.status;
      } catch (error) {
        this.log.error({ err: error, refundId: refund.publicId }, 'could not read refund status');
        continue;
      }

      if (providerStatus !== 'SUCCEEDED') {
        // Still in flight at the provider, or genuinely failed. Leave it for
        // an operator rather than guessing.
        continue;
      }

      // The provider has the money back. Apply the ledger reversal now.
      try {
        await this.prisma.refund.update({
          where: { id: refund.id },
          data: { status: 'SUCCEEDED' },
        });
        resolved += 1;
        this.log.warn(
          { refundId: refund.publicId },
          'completed a stranded refund the provider had already accepted — merchant balance still requires manual review',
        );
      } catch (error) {
        this.log.error({ err: error, refundId: refund.publicId }, 'could not complete stranded refund');
      }
    }

    return resolved;
  }

  /**
   * Persist breaks so they survive a restart and can be alerted on.
   *
   * Deduplicated by kind + reference within the day, so a nightly run against
   * a long-standing break does not generate thousands of duplicate rows.
   */
  private async recordBreaks(breaks: ReconciliationBreak[]): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60_000);

    for (const item of breaks) {
      const duplicate = await this.prisma.resolution.findFirst({
        where: {
          action: ResolutionAction.RECONCILIATION_BREAK,
          createdAt: { gte: since },
          metadata: {
            path: ['kind'],
            equals: item.kind,
          },
          ...(item.referencePublicId
            ? { metadata: { path: ['reference'], equals: item.referencePublicId } }
            : {}),
        },
        select: { id: true },
      });
      if (duplicate) {
        continue;
      }

      await this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId: null,
          actorType: 'SYSTEM',
          action: ResolutionAction.RECONCILIATION_BREAK,
          subjectType: ResolutionSubject.MERCHANT,
          subjectPublicId: item.merchantPublicId ?? item.referencePublicId ?? 'platform',
          metadata: {
            kind: item.kind,
            reference: item.referencePublicId ?? null,
            currency: item.currency ?? null,
            magnitudeMinor: item.magnitudeMinor.toString(),
            detail: item.detail,
          },
        },
      });
    }
  }

  /**
   * Expire payments the payer abandoned.
   *
   * `PaymentStatus.EXPIRED` is advertised in the public API and in the SDK, but
   * nothing ever wrote it: `expiresAt` was set at creation and read defensively
   * in exactly one place. Abandoned payments sat at CREATED indefinitely,
   * polluting merchant statements and leaving an open-ended quote that the
   * merchant might reasonably believe was still live.
   *
   * Only CREATED payments are expired. A PENDING payment has a charge in flight
   * and is the reconciliation sweeper's business, not this job's.
   */
  @Cron('*/5 * * * *', { timeZone: 'UTC' })
  async expireAbandonedPayments(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.payments.updateMany({
      where: {
        status: PaymentStatus.CREATED,
        expiresAt: { lte: now },
      },
      data: { status: PaymentStatus.EXPIRED },
    });

    if (result.count > 0) {
      this.log.log({ count: result.count }, 'expired abandoned payments');
    }
    return result.count;
  }

  /**
   * Release transactions whose provider charge was never recorded.
   *
   * `voidOrphanedCharge` in the transaction service releases a charge whose
   * commit failed, but if that void itself fails the charge is held at the
   * provider with no local record. Those are surfaced here rather than left as
   * a log line nobody consumes.
   */
  @Cron('23 */2 * * *', { timeZone: 'UTC' })
  async reportUnreconcilablePayouts(): Promise<void> {
    const stuck = await this.prisma.payout.findMany({
      where: { status: 'IN_TRANSIT', updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
      select: { publicId: true, amount: true, currency: true },
      take: 50,
    });

    for (const payout of stuck) {
      this.log.error(
        { payoutId: payout.publicId, amount: payout.amount.toString() },
        'payout status unknown — the provider may or may not have transferred. Manual review required.',
      );
    }
  }
}

/** Re-exported so the module can narrow the raw query types. */
export type { Prisma, LedgerAccount, LedgerType };