import { Inject, Injectable } from '@nestjs/common';
import {
  ActorType,
  LedgerAccount,
  LedgerType,
  PaymentStatus,
  Prisma,
  Refund,
  ResolutionAction,
  ResolutionSubject,
  TransactionStatus,
} from '@prisma/client';
import { splitFee, type FeeSchedule } from '../../common/money/money';
import { generatePublicId, withPublicId } from '../../common/utils/generate-public-id';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { logger } from '../../common/logger/logger';
import { PrismaService } from '../../database/prisma.service';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { WebhookBody } from '../bank/webhook-signature';
import { presentTransaction, transactionInclude } from '../transactions/transaction.presenter';
import { WebhookDispatcher } from './webhook-dispatcher.service';

@Injectable()
export class SettlementService {
  private readonly log = logger.child({ module: 'settlement' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookDispatcher,
    @Inject(BANK_PORT) private readonly bank: BankPort,
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
            // the funds regardless, so the journal must reflect them. Leaving
            // this unposted stranded real money at the bank with no merchant
            // credit, no platform fee, and nothing to reconcile against.
            this.log.error(
              { paymentId: existing.paymentId, gatewayRef: body.gatewayRef },
              'settled a charge on a cancelled payment — posting from captured funds',
            );

            // Repair the payment state only. The journal posting happens once,
            // below, in the shared `if (succeeded)` block.
            //
            // Posting here as well was a real defect: it wrote the same
            // referenceId twice, so the second post collided on
            // [account, accountKey, referenceId, type], aborted the whole
            // transaction, and — because `withPublicId` retries a unique
            // violation — surfaced as a misleading
            // "current transaction is aborted" rather than the collision
            // itself. Found by the integration suite, not by any unit test.
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

    // No dispatch here: the event is enqueued inside the transaction above so
    // a failure rolls the settlement back instead of silently losing the
    // notification. Dispatching again post-commit would deliver it twice.

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

    // Replay check FIRST, before any guard that reads current payment state.
    //
    // These guards are evaluated against state the *first* attempt already
    // changed: a full refund moves the payment to REFUNDED, so a retry of a
    // successful full refund used to be rejected with PAYMENT_NOT_REFUNDABLE
    // before the idempotency key was ever consulted. A client that retries on
    // any error then sees a failure for work that genuinely succeeded, which is
    // how "safe" retries end up looking like lost refunds.
    const replayed = await this.findRefundByKey(payment.merchantId, input.idempotencyKey);
    if (replayed) {
      const requestedForReplay = input.amountMinor ?? replayed.amount;
      if (requestedForReplay !== replayed.amount) {
        throw ApiError.of(
          ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
          'That idempotency key was already used for a refund of a different amount.',
          {
            meta: {
              originalAmount: replayed.amount.toString(),
              requestedAmount: requestedForReplay.toString(),
            },
          },
        );
      }
      return replayed;
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

    // ---- Phase 1: reserve the idempotency key -------------------------
    //
    // Committed on its own so the reservation survives the provider call
    // below. This also supplies the read-side idempotency the refund path
    // never had: a retry with the same key returns the original refund
    // instead of falling through to the unique-violation rollback and a 409.
    const reserved = await this.reserveRefund({
      payment,
      transactionId: transaction.id,
      input,
      requested,
      feeReversed,
      netReversed,
      currency: transaction.currency,
    });
    if (reserved.replayed) {
      return reserved.refund;
    }
    const refundRow = reserved.refund;

    // ---- Phase 2: move the money at the provider ----------------------
    //
    // Irreversible. The reservation above means a crash here leaves a PENDING
    // row that reconciliation can resolve, rather than an unrecorded refund.
    let gatewayRefundRef: string;
    try {
      const result = await this.bank.refund({
        gatewayRef: transaction.gatewayRef,
        amountMinor: requested,
        currency: transaction.currency,
        // Namespaced by payment so two merchants reusing a generic
        // idempotency key cannot collide at the provider, which would
        // silently suppress one of the refunds.
        idempotencyKey: `refund:${payment.id}:${input.idempotencyKey}`,
      });
      gatewayRefundRef = result.refundRef;
    } catch (error) {
      this.log.error(
        { err: error, paymentId: payment.publicId, amount: requested.toString() },
        'provider refund failed',
      );
      await this.prisma.refund.update({
        where: { id: refundRow.id },
        data: { status: 'FAILED', failureReason: 'Bank rejected the refund' },
      });
      throw ApiError.of(
        ErrorCode.BANK_CHARGE_FAILED,
        'The bank declined this refund. No money has been returned.',
        { cause: error },
      );
    }

    // ---- Phase 3: post the ledger reversal ----------------------------
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
          // The provider has already refunded. The ledger still has to follow,
          // otherwise reconciliation will find an unreversed merchant debit.
          this.log.error(
            { paymentId: payment.publicId, refundId: refundRow.publicId },
            'provider refunded but the payment changed underneath — manual reconciliation required',
          );
          throw ApiError.of(
            ErrorCode.ALREADY_IN_STATE,
            'This payment changed while the refund was being applied. Please retry.',
          );
        }

        // The ledger reference is unique per refund, not per amount. Two
        // partial refunds of the same value on one transaction previously
        // produced an identical referenceId, colliding on the
        // [account, accountKey, referenceId, type] unique index and rolling
        // back the second refund entirely.
        await this.pull(tx, {
          merchantId: payment.merchantId,
          currency: transaction.currency,
          referenceId: `refund:${refundRow.publicId}`,
          fee: feeReversed,
          net: netReversed,
        });

        const updated = await tx.refund.update({
          where: { id: refundRow.id },
          data: { status: 'SUCCEEDED', gatewayRefundRef },
        });

        await tx.resolution.create({
          data: {
            publicId: generatePublicId('pf-res'),
            actorId: input.actorId,
            actorType: input.actorType,
            action: ResolutionAction.REFUND,
            subjectType: ResolutionSubject.PAYMENT,
            subjectPublicId: input.paymentPublicId,
            metadata: {
              refundId: updated.publicId,
              gatewayRefundRef,
              amount: requested.toString(),
              currency: transaction.currency,
              ...(input.reason ? { reason: input.reason } : {}),
            },
          },
        });

        return updated;
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
 * Find an existing refund for this merchant and idempotency key.
 *
 * This is the read half of idempotency. The unique constraint on
 * (merchantId, idempotencyKey) is the write half and catches the race; this
 * turns an exact replay into the original result rather than a 409.
 */
private async findRefundByKey(
    merchantId: string,
    idempotencyKey: string,
  ): Promise<Refund | null> {
    return this.prisma.refund.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
    });
  }

  /**
   * Reserve a refund's idempotency key before the provider is contacted.
   *
   * Committed on its own so the reservation outlives the bank call. On a
   * duplicate key the existing refund is returned rather than raising, which is
   * what makes a retry of a successful refund return the original result
   * instead of a 409 from the unique-violation rollback.
   */
  private async reserveRefund(input: {
    payment: { id: string; publicId: string; merchantId: string };
    transactionId: string;
    input: {
      paymentPublicId: string;
      reason?: string;
      idempotencyKey: string;
      actorId: string;
      actorType: ActorType;
    };
    requested: bigint;
    feeReversed: bigint;
    netReversed: bigint;
    currency: string;
  }): Promise<{ replayed: boolean; refund: Refund }> {
    const existing = await this.findRefundByKey(
      input.payment.merchantId,
      input.input.idempotencyKey,
    );
    if (existing) {
      // A different amount under a reused key is a client bug, not a retry.
      if (existing.amount !== input.requested) {
        throw ApiError.of(
          ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
          'That idempotency key was already used for a refund of a different amount.',
        );
      }
      return { replayed: true, refund: existing };
    }

    try {
      const created = await withPublicId(
        'pf-ref',
        (publicId) =>
          this.prisma.refund.create({
            data: {
              publicId,
              paymentId: input.payment.id,
              transactionId: input.transactionId,
              merchantId: input.payment.merchantId,
              amount: input.requested,
              currency: input.currency,
              feeReversed: input.feeReversed,
              netReversed: input.netReversed,
              reason: input.input.reason,
              status: 'PENDING',
              idempotencyKey: input.input.idempotencyKey,
              createdById: input.input.actorId,
            },
          }),
        isUniqueViolation,
      );
      return { replayed: false, refund: created };
    } catch (error) {
      // Lost the race against a concurrent request with the same key. The
      // winner owns the refund; return theirs rather than failing the caller.
      if (isUniqueViolation(error)) {
        const raced = await this.findRefundByKey(
          input.payment.merchantId,
          input.input.idempotencyKey,
        );
        if (raced) {
          return { replayed: true, refund: raced };
        }
      }
      throw error;
    }
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
    const balanceAfter =
      input.net > 0n
        ? await applyBalance(tx, input.merchantId, input.currency, input.net, 'decrement')
        : null;

    // Both legs are omitted when zero.
    //
    // Cumulative rounding can legitimately attribute a whole slice to fee: on
    // the final refund of a 3-minor-unit payment refunded 1/1/1, the last slice
    // carries fee 1 and net 0. `Ledgers` carries CHECK (amount > 0), so writing
    // that zero leg aborted the transaction and made the final refund
    // impossible — the exact failure this whole change set was meant to remove.
    // A zero leg carries no information: the clearing leg still records the
    // full part, so the reference continues to balance.
    if (input.net > 0n) {
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
    }

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

/**
 * Whether this error is a retryable collision on a generated public id.
 *
 * Only P2002 (unique constraint) counts. P2003 is a foreign-key violation and
 * is not a collision: retrying it with a fresh public id cannot succeed, and
 * inside a Postgres transaction the first failure aborts the transaction, so
 * the retry surfaces a misleading
 * "current transaction is aborted" error and hides the real cause.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}