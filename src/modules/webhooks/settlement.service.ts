import { Injectable } from '@nestjs/common';
import {
  ActorType,
  LedgerAccount,
  LedgerType,
  PaymentStatus,
  Prisma,
  ResolutionAction,
  ResolutionSubject,
  TransactionStatus,
} from '@prisma/client';
import { splitFee, type FeeSchedule } from '../../common/money/money';
import { generatePublicId, withPublicId } from '../../common/utils/generate-public-id';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { logger } from '../../common/logger/logger';
import { PrismaService } from '../../database/prisma.service';
import { WebhookBody } from '../bank/webhook-signature';
import { presentTransaction, transactionInclude } from '../transactions/transaction.presenter';
import { WebhookDispatcher } from './webhook-dispatcher.service';

@Injectable()
export class SettlementService {
  private readonly log = logger.child({ module: 'settlement' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  /**
   * Apply a bank outcome to a transaction and move money.
   *
   * Correctness properties this method must preserve:
   *  1. At most one application per `gatewayRef`. Enforced by a compare-and-set
   *     on the transaction status, not by a read-then-write.
   *  2. A late webhook must never resurrect a refunded payment. The payment
   *     update is also a compare-and-set, and explicitly refuses to leave
   *     REFUNDED or PARTIALLY_REFUNDED.
   *  3. Ledger rows and balance changes commit together or not at all.
   */
  async settle(body: WebhookBody) {
    const existing = await this.prisma.transactions.findUnique({
      where: { gatewayRef: body.gatewayRef },
      include: transactionInclude,
    });
    if (!existing) {
      throw ApiError.of(ErrorCode.TRANSACTION_NOT_FOUND);
    }
    if (
      existing.status === TransactionStatus.SUCCESS ||
      existing.status === TransactionStatus.FAILED
    ) {
      if (existing.status === body.status) {
        return { replayed: true, transaction: presentTransaction(existing) };
      }
      throw ApiError.of(
        ErrorCode.TRANSACTION_FINALIZED,
        'This transaction has already been finalized.',
      );
    }
    if (existing.status === TransactionStatus.VOIDED || existing.status === TransactionStatus.EXPIRED) {
      throw ApiError.of(
        ErrorCode.TRANSACTION_FINALIZED,
        `This transaction is ${existing.status.toLowerCase()} and cannot settle.`,
      );
    }

    const succeeded = body.status === 'SUCCESS';
    const feeSchedule: FeeSchedule = {
      basisPoints: existing.payment.feeBasisPoints,
    };
    const { fee, net } = splitFee(existing.amount, feeSchedule);

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.transactions.updateMany({
          where: { id: existing.id, status: TransactionStatus.PENDING },
          data: {
            status: body.status,
            fee: succeeded ? fee : 0n,
            netAmount: succeeded ? net : 0n,
            settledAt: succeeded ? new Date() : new Date(),
            failureCode: succeeded ? null : body.failureCode ?? 'DECLINED',
            failureMessage: succeeded ? null : body.failureMessage ?? 'The bank declined the charge.',
          },
        });

        if (updated.count === 0) {
          const current = await tx.transactions.findUnique({
            where: { id: existing.id },
            select: { status: true },
          });
          return current?.status === body.status ? 'replay' : 'conflict';
        }

        // Compare-and-swap here too. Without the status predicate, a webhook
        // arriving after an admin refund would silently drag REFUNDED back to
        // SUCCESS, reversing the refund and re-crediting the merchant.
        if (succeeded) {
          const paid = await tx.payments.updateMany({
            where: {
              id: existing.paymentId,
              status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
            },
            data: { status: PaymentStatus.SUCCESS },
          });
          if (paid.count === 0) {
            // The payment moved out from under us. This is reachable: the
            // payer can cancel a PENDING payment while a charge is in flight,
            // because `transaction.create` sets the payment to PENDING before
            // the bank settles.
            const current = await tx.payments.findUnique({
              where: { id: existing.paymentId },
              select: { status: true, merchantId: true, publicId: true },
            });

            if (
              current?.status === PaymentStatus.REFUNDED ||
              current?.status === PaymentStatus.PARTIALLY_REFUNDED
            ) {
              // Money already went back to the payer. Do not credit again.
              this.log.error(
                { paymentId: existing.paymentId, gatewayRef: body.gatewayRef },
                'settled a transaction whose payment was already refunded',
              );
              return 'payment_not_payable';
            }

            // CANCELLED (or any other terminal state): the provider captured
            // the funds regardless, so the ledger must reflect them. Leaving
            // this unposted stranded real money at the bank with no merchant
            // credit, no platform fee, and nothing to reconcile against.
            this.log.error(
              { paymentId: existing.paymentId, gatewayRef: body.gatewayRef },
              'settled a charge on a cancelled payment — posting from captured funds',
            );

            await this.post(tx, {
              merchantId: existing.payment.merchantId,
              currency: existing.currency,
              referenceId: `settlement:${existing.publicId}`,
              fee,
              net,
            });

            // Move the payment to SUCCESS so the merchant sees real money and
            // the refund path becomes available to them if they want it back.
            await tx.payments.update({
              where: { id: existing.paymentId },
              data: { status: PaymentStatus.SUCCESS, cancelledReason: null },
            });

            await tx.resolution.create({
              data: {
                publicId: generatePublicId('pf-res'),
                actorId: null,
                actorType: 'SYSTEM',
                action: ResolutionAction.SETTLE_CANCELLED_PAYMENT,
                subjectType: ResolutionSubject.PAYMENT,
                subjectPublicId: existing.payment.publicId,
                metadata: {
                  gatewayRef: body.gatewayRef,
                  reason: 'charge captured after the payment was cancelled',
                },
              },
            });
          }
        } else {
          await tx.payments.updateMany({
            where: {
              id: existing.paymentId,
              status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
            },
            data: { status: PaymentStatus.FAILED },
          });
        }

        if (succeeded) {
          await this.post(
            tx,
            {
              merchantId: existing.payment.merchantId,
              currency: existing.currency,
              referenceId: `settlement:${existing.publicId}`,
              fee,
              net,
            },
          );

          // Enqueue inside the transaction. Previously this ran after the
          // commit, so a failure here returned 500 to the bank, the bank
          // retried, and `settle()` hit the replay branch above — which
          // returns { replayed: true } without re-dispatching. The merchant
          // was never told the payment succeeded, and nothing logged it.
          await this.webhooks.dispatchPaymentEvent({
            paymentId: existing.paymentId,
            type: 'PAYMENT_SUCCEEDED',
          });
        } else {
          await this.webhooks.dispatchPaymentEvent({
            paymentId: existing.paymentId,
            type: 'PAYMENT_FAILED',
          });
        }
        return 'applied';
      },
      { maxWait: 10000, timeout: 20000 },
    );

    if (outcome === 'conflict') {
      throw ApiError.of(ErrorCode.TRANSACTION_FINALIZED, 'This transaction has already been finalized.');
    }

    const fresh = await this.prisma.transactions.findUniqueOrThrow({
      where: { id: existing.id },
      include: transactionInclude,
    });

    if (outcome === 'applied') {
      await this.webhooks.dispatchPaymentEvent({
        paymentId: existing.paymentId,
        type: succeeded ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
      });
    }

    return { replayed: outcome === 'replay', transaction: presentTransaction(fresh) };
  }

  /**
   * Refund all or part of a settled payment.
   *
   * Partial refunds are tracked on `Payments.refundedAmount`, which is bounded
   * by a database CHECK against `settlementAmount`. Each refund posts its own
   * compensating ledger pair, so the journal stays auditable and a partial
   * refund never rewrites history.
   */
  async refund(input: {
    paymentPublicId: string;
    amountMinor?: bigint;
    currency: string;
    reason?: string;
    idempotencyKey: string;
    actorId: string;
    actorType: ActorType;
  }) {
    const payment = await this.prisma.payments.findUnique({
      where: { publicId: input.paymentPublicId },
      include: { transactions: { where: { status: TransactionStatus.SUCCESS } } },
    });

    if (!payment) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_FOUND);
    }
    if (
      payment.status !== PaymentStatus.SUCCESS &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_REFUNDABLE);
    }

    const transaction = payment.transactions[0];
    if (!transaction) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_REFUNDABLE);
    }

    const alreadyRefunded = payment.refundedAmount;
    const remaining = payment.settlementAmount - alreadyRefunded;
    const requested = input.amountMinor ?? remaining;

    if (requested <= 0n) {
      throw ApiError.of(ErrorCode.REFUND_EXCEEDS_REMAINING, 'Enter a refund amount greater than zero.');
    }
    if (requested > remaining) {
      throw ApiError.of(
        ErrorCode.REFUND_EXCEEDS_REMAINING,
        `You can refund at most ${remaining} ${payment.settlementCurrency} of this payment.`,
        { meta: { refundableMinor: remaining.toString(), currency: payment.settlementCurrency } },
      );
    }

    // Pro-rata fee and net reversal, rounded so that partial refunds summing to
    // the full gross reverse exactly the original fee and net.
    const { fee: feeReversed, net: netReversed } = splitProRata(
      transaction.fee,
      transaction.amount,
      requested,
      alreadyRefunded,
    );

    const nowPaid = nowRefundedAfter(requested, remaining, alreadyRefunded, payment.settlementAmount);

    const refund = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.payments.updateMany({
          where: {
            id: payment.id,
            status: {
              in: [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED],
            },
            refundedAmount: alreadyRefunded,
          },
          data: {
            refundedAmount: alreadyRefunded + requested,
            status: nowPaid,
          },
        });
        if (claimed.count === 0) {
          throw ApiError.of(
            ErrorCode.ALREADY_IN_STATE,
            'This payment changed while the refund was being applied. Please retry.',
          );
        }

        // The ledger reference must be unique per refund, not per amount. Two
      // partial refunds of the same value on one transaction previously
      // produced an identical referenceId, colliding on the
      // [account, accountKey, referenceId, type] unique index and rolling
      // back the second refund entirely.
      await this.pull(tx, {
        merchantId: payment.merchantId,
        currency: transaction.currency,
        referenceId: `refund:${input.idempotencyKey}:${payment.id}`,
        fee: feeReversed,
        net: netReversed,
      });

        const created = await withPublicId(
          'pf-ref',
          (publicId) =>
            tx.refund.create({
              data: {
                publicId,
                paymentId: payment.id,
                transactionId: transaction.id,
                merchantId: payment.merchantId,
                amount: requested,
                currency: transaction.currency,
                feeReversed,
                netReversed,
                reason: input.reason,
                status: 'SUCCEEDED',
                idempotencyKey: input.idempotencyKey,
                createdById: input.actorId,
              },
            }),
          isUniqueViolation,
        );

        await tx.resolution.create({
          data: {
            publicId: generatePublicId('pf-res'),
            actorId: input.actorId,
            actorType: input.actorType,
            action: ResolutionAction.REFUND,
            subjectType: ResolutionSubject.PAYMENT,
            subjectPublicId: input.paymentPublicId,
            metadata: {
              refundId: created.publicId,
              amount: requested.toString(),
              currency: transaction.currency,
              ...(input.reason ? { reason: input.reason } : {}),
            },
          },
        });

        return created;
      },
      { maxWait: 10000, timeout: 20000 },
    );

    await this.webhooks.dispatchPaymentEvent({
      paymentId: payment.id,
      type: 'PAYMENT_REFUNDED',
    });

    return refund;
  }

  /**
   * Post a settled charge.
   *
   * Three legs, balanced:
   *   DEBIT  PSP_CLEARING   gross — funds captured from the payer
   *   CREDIT MERCHANT       net   — the merchant's earning
   *   CREDIT PLATFORM       fee   — the platform's cut
   *
   * The previous implementation wrote only the two CREDIT legs, which left
   * sum(debits) = 0 system-wide and made the journal unauditable.
   */
  private async post(
    tx: Prisma.TransactionClient,
    input: { merchantId: string; currency: string; referenceId: string; fee: bigint; net: bigint },
  ) {
    const balanceAfter = await applyBalance(tx, input.merchantId, input.currency, input.net, 'increment');
    await writeLedger(tx, {
      account: LedgerAccount.MERCHANT,
      accountKey: input.merchantId,
      merchantId: input.merchantId,
      currency: input.currency,
      amount: input.net,
      type: LedgerType.CREDIT,
      referenceId: input.referenceId,
      balanceAfter,
    });

    if (input.fee > 0n) {
      await applyPlatform(tx, input.currency, input.fee, 'increment');
      await writeLedger(tx, {
        account: LedgerAccount.PLATFORM,
        accountKey: 'PLATFORM',
        merchantId: null,
        currency: input.currency,
        amount: input.fee,
        type: LedgerType.CREDIT,
        referenceId: input.referenceId,
        balanceAfter: null,
      });
    }

    // Counter-leg. The payer handed this money to the provider; it is the
    // platform's liability until it is swept to a merchant balance. Without
    // it the other two legs are both CREDITs and sum(debits) = 0, so the
    // journal cannot be shown to balance.
    await writeLedger(tx, {
      account: LedgerAccount.PSP_CLEARING,
      accountKey: 'PSP',
      merchantId: null,
      currency: input.currency,
      amount: input.net + input.fee,
      type: LedgerType.DEBIT,
      referenceId: input.referenceId,
      balanceAfter: null,
    });
  }

  /**
   * Post a refund, the mirror of `post`.
   *
   *   DEBIT  MERCHANT       net   — reverse the merchant's earning
   *   DEBIT  PLATFORM       fee   — reverse the platform's fee
   *   CREDIT PSP_CLEARING   gross — funds returned to the payer
   */
  private async pull(
    tx: Prisma.TransactionClient,
    input: { merchantId: string; currency: string; referenceId: string; fee: bigint; net: bigint },
  ) {
    const balanceAfter = await applyBalance(tx, input.merchantId, input.currency, input.net, 'decrement');

    await writeLedger(tx, {
      account: LedgerAccount.MERCHANT,
      accountKey: input.merchantId,
      merchantId: input.merchantId,
      currency: input.currency,
      amount: input.net,
      type: LedgerType.DEBIT,
      referenceId: input.referenceId,
      balanceAfter,
    });

    if (input.fee > 0n) {
      await applyPlatform(tx, input.currency, input.fee, 'decrement');
      await writeLedger(tx, {
        account: LedgerAccount.PLATFORM,
        accountKey: 'PLATFORM',
        merchantId: null,
        currency: input.currency,
        amount: input.fee,
        type: LedgerType.DEBIT,
        referenceId: input.referenceId,
        balanceAfter: null,
      });
    }

    // Mirror of the settlement counter-leg: funds flow back out to the payer.
    await writeLedger(tx, {
      account: LedgerAccount.PSP_CLEARING,
      accountKey: 'PSP',
      merchantId: null,
      currency: input.currency,
      amount: input.net + input.fee,
      type: LedgerType.CREDIT,
      referenceId: input.referenceId,
      balanceAfter: null,
    });
  }
}

/**
 * Split a settled amount pro rata between fee and net for one partial refund.
 *
 * Uses cumulative rounding: the split is computed against the running total
 * already refunded, and the delta from what has previously been reversed is
 * returned. When the cumulative refund reaches the gross amount the deltas sum
 * to exactly the original fee and net.
 *
 * The previous implementation divided `totalFee * part / totalGross` on each
 * refund independently. That truncates, so N partial refunds summing to the
 * full gross reversed `totalFee - N` rather than `totalFee` — on a fully
 * refunded payment the platform retained the entire fee, and the resulting
 * over-debit could drive the merchant balance to zero and make the final
 * refund unpayable.
 */
export function splitProRata(
  totalFee: bigint,
  totalGross: bigint,
  part: bigint,
  alreadyRefunded: bigint,
): { fee: bigint; net: bigint } {
  if (totalGross <= 0n || part <= 0n) {
    return { fee: 0n, net: 0n };
  }

  const cumulative = alreadyRefunded + part;
  const feeCumulative = (totalFee * cumulative) / totalGross;
  const netCumulative = cumulative - feeCumulative;

  const feePrevious = (totalFee * alreadyRefunded) / totalGross;
  const netPrevious = alreadyRefunded - feePrevious;

  return {
    fee: feeCumulative - feePrevious,
    net: netCumulative - netPrevious,
  };
}

function nowRefundedAfter(
  requested: bigint,
  remaining: bigint,
  alreadyRefunded: bigint,
  settlementAmount: bigint,
): PaymentStatus {
  return alreadyRefunded + requested >= settlementAmount
    ? PaymentStatus.REFUNDED
    : PaymentStatus.PARTIALLY_REFUNDED;
}

async function applyBalance(
  tx: Prisma.TransactionClient,
  merchantId: string,
  currency: string,
  amount: bigint,
  direction: 'increment' | 'decrement',
): Promise<bigint> {
  await tx.merchantBalance.upsert({
    where: { merchantId_currency: { merchantId, currency } },
    create: { merchantId, currency, balance: 0n },
    update: {},
  });

  // Row lock serialises read-modify-write across concurrent settlements for
  // the same merchant+currency. Without it, two simultaneous credits read the
  // same starting balance and one increment is lost.
  await tx.$queryRaw`
    SELECT "id" FROM "MerchantBalance"
    WHERE "merchantId" = ${merchantId} AND "currency" = ${currency}
    FOR UPDATE
  `;

  if (direction === 'decrement') {
    const row = await tx.merchantBalance.findUnique({
      where: { merchantId_currency: { merchantId, currency } },
    });
    if (!row || row.balance < amount) {
      throw ApiError.of(
        ErrorCode.INSUFFICIENT_BALANCE,
        'The merchant balance is below the amount being reversed.',
      );
    }
  }

  const updated = await tx.merchantBalance.update({
    where: { merchantId_currency: { merchantId, currency } },
    data: { balance: { [direction]: amount } },
    select: { balance: true },
  });
  return updated.balance;
}

async function applyPlatform(
  tx: Prisma.TransactionClient,
  currency: string,
  amount: bigint,
  direction: 'increment' | 'decrement',
) {
  await tx.platformAccount.upsert({
    where: { currency },
    create: { currency, balance: 0n },
    update: {},
  });
  await tx.$queryRaw`
    SELECT "id" FROM "PlatformAccount"
    WHERE "currency" = ${currency}
    FOR UPDATE
  `;

  if (direction === 'decrement') {
    const row = await tx.platformAccount.findUnique({ where: { currency } });
    if (!row || row.balance < amount) {
      throw ApiError.of(
        ErrorCode.INSUFFICIENT_BALANCE,
        'The platform balance is below the amount being reversed.',
      );
    }
  }

  await tx.platformAccount.update({
    where: { currency },
    data: { balance: { [direction]: amount } },
  });
}

async function writeLedger(
  tx: Prisma.TransactionClient,
  input: {
    account: LedgerAccount;
    accountKey: string;
    merchantId: string | null;
    currency: string;
    amount: bigint;
    type: LedgerType;
    referenceId: string;
    balanceAfter: bigint | null;
  },
) {
  await withPublicId(
    'pf-ledger',
    (publicId) =>
      tx.ledgers.create({
        data: {
          publicId,
          account: input.account,
          accountKey: input.accountKey,
          merchantId: input.merchantId,
          currency: input.currency,
          amount: input.amount,
          type: input.type,
          referenceId: input.referenceId,
          balanceAfter: input.balanceAfter,
        },
      }),
    isUniqueViolation,
  );
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2003')
  );
}