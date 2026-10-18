import { Inject, Injectable } from '@nestjs/common';
import { ActorType, Prisma, type PayoutStatus } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { assertIdempotencyKey } from '../../common/idempotency/idempotency';
import { toMajorNumber } from '../../common/money/money';
import { paginatedQuery } from '../../common/pagination/pagination';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookDispatcher,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {}

  /**
   * Schedule money out to a merchant.
   *
   * The balance is debited *now*, at schedule time, not at payout time. Holding
   * the funds for the settlement delay is the entire point of the pending/available
   * split; debiting on execution would let a merchant request two payouts
   * against the same balance and only fail at the bank.
   */
  async create(input: {
    merchantId: string;
    amountMinor: bigint;
    currency: string;
    destinationId: string;
    idempotencyKey: string;
    requestedById: string;
    actorType: ActorType;
  }) {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);

    const existing = await this.prisma.payout.findUnique({
      where: { merchantId_idempotencyKey: { merchantId: input.merchantId, idempotencyKey } },
    });
    if (existing) {
      return this.present(existing);
    }

    const destination = await this.prisma.payoutDestination.findUnique({
      where: { publicId: input.destinationId },
    });
    if (!destination || destination.merchantId !== input.merchantId) {
      throw ApiError.of(ErrorCode.DESTINATION_NOT_FOUND);
    }
    if (destination.status !== 'ACTIVE') {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'That payout destination is not active.',
      );
    }
    if (destination.currency !== input.currency) {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        `That destination pays out in ${destination.currency}, not ${input.currency}.`,
      );
    }
    if (input.amountMinor <= 0n) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Enter a payout amount greater than zero.');
    }

    try {
      const payout = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "MerchantBalance"
            WHERE "merchantId" = ${input.merchantId} AND "currency" = ${input.currency}
            FOR UPDATE
          `;

          const balance = await tx.merchantBalance.findUnique({
            where: { merchantId_currency: { merchantId: input.merchantId, currency: input.currency } },
          });
          if (!balance || balance.balance < input.amountMinor) {
            throw ApiError.of(
              ErrorCode.INSUFFICIENT_BALANCE,
              'Your available balance is below the requested payout amount.',
              {
                meta: {
                  available: balance ? toMajorNumber(balance.balance, input.currency) : 0,
                  currency: input.currency,
                },
              },
            );
          }

          const created = await tx.payout.create({
            data: {
              publicId: generatePublicId('pf-po'),
              merchantId: input.merchantId,
              destinationId: destination.id,
              amount: input.amountMinor,
              currency: input.currency,
              status: 'SCHEDULED',
              idempotencyKey,
              requestedById: input.requestedById,
            },
          });

          await tx.merchantBalance.update({
            where: { merchantId_currency: { merchantId: input.merchantId, currency: input.currency } },
            data: { balance: { decrement: input.amountMinor } },
          });

          // A payout leaves the platform, so it needs a counter-leg or the
          // journal cannot balance. The merchant leg is a DEBIT against funds
          // held on their behalf; the clearing leg is the matching CREDIT
          // that leaves the platform's books. Both are written at schedule
          // time so the position is complete while the transfer is in flight.
          await tx.ledgers.createMany({
            data: [
              {
                publicId: generatePublicId('pf-ledger'),
                account: 'MERCHANT',
                accountKey: input.merchantId,
                merchantId: input.merchantId,
                currency: input.currency,
                amount: input.amountMinor,
                type: 'DEBIT',
                referenceId: created.publicId,
              },
              {
                publicId: generatePublicId('pf-ledger'),
                account: 'MERCHANT_CLEARING',
                accountKey: input.merchantId,
                merchantId: input.merchantId,
                currency: input.currency,
                amount: input.amountMinor,
                type: 'CREDIT',
                referenceId: created.publicId,
              },
            ],
          });

          await tx.resolution.create({
            data: {
              publicId: generatePublicId('pf-res'),
              actorId: input.requestedById,
              actorType: input.actorType,
              action: 'PAYOUT_CREATED',
              subjectType: 'PAYOUT',
              subjectPublicId: created.publicId,
              metadata: { amount: input.amountMinor.toString(), currency: input.currency },
            },
          });

          return created;
        },
        { maxWait: 10000, timeout: 20000 },
      );

      // A payout is scheduled, not paid. Emitting PAYOUT_PAID here told the
      // merchant's integration the money had been sent while the row was still
      // SCHEDULED and the balance debit had not been matched by any bank
      // transfer. PAYOUT_PAID is emitted by PayoutExecutor once the provider
      // has actually accepted the transfer.
      await this.webhooks.dispatchPayoutEvent({
        payoutId: payout.id,
        type: 'PAYOUT_SCHEDULED',
      });
      return this.present(payout);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.payout.findUnique({
          where: { merchantId_idempotencyKey: { merchantId: input.merchantId, idempotencyKey } },
        });
        if (raced) {
          return this.present(raced);
        }
      }
      throw error;
    }
  }

  async list(merchantId: string, params: { limit: number; cursor?: string; order?: 'asc' | 'desc' }) {
    return paginatedQuery({
      scope: { merchantId },
      query: (where, take, orderBy) =>
        this.prisma.payout.findMany({
          where: where as Prisma.PayoutWhereInput,
          orderBy: orderBy as Prisma.PayoutOrderByWithRelationInput[],
          take,
        }),
      present: (row) => this.present(row),
      ...params,
    });
  }

  async get(merchantId: string, publicId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { publicId } });
    if (!payout || payout.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.PAYOUT_NOT_FOUND);
    }
    return this.present(payout);
  }

  /** Advance a payout at the bank and mirror the result locally. */
  async markPaid(publicId: string, externalRef: string) {
    const payout = await this.prisma.payout.findUnique({ where: { publicId } });
    if (!payout) {
      throw ApiError.of(ErrorCode.PAYOUT_NOT_FOUND);
    }
    if (payout.status !== 'SCHEDULED' && payout.status !== 'IN_TRANSIT') {
      throw ApiError.of(ErrorCode.ALREADY_IN_STATE, `This payout is already ${payout.status}.`);
    }

    const updated = await this.prisma.payout.updateMany({
      where: { id: payout.id, status: { in: ['SCHEDULED', 'IN_TRANSIT'] } },
      data: { status: 'PAID', externalRef, processedAt: new Date() },
    });
    if (updated.count === 0) {
      throw ApiError.of(ErrorCode.ALREADY_IN_STATE);
    }

    await this.webhooks.dispatchPayoutEvent({ payoutId: payout.id, type: 'PAYOUT_PAID' });
    return this.get(payout.merchantId, publicId);
  }

  /**
   * Return a failed payout to the merchant's available balance, with a
   * compensating CREDIT ledger row. Without this, a payout that fails at the
   * bank silently destroys the merchant's money.
   */
  async markFailed(publicId: string, reason: string) {
    const payout = await this.prisma.payout.findUnique({ where: { publicId } });
    if (!payout) {
      throw ApiError.of(ErrorCode.PAYOUT_NOT_FOUND);
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({
        where: { id: payout.id, status: { in: ['SCHEDULED', 'IN_TRANSIT'] } },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
      if (claimed.count === 0) {
        return;
      }

      await tx.merchantBalance.upsert({
        where: { merchantId_currency: { merchantId: payout.merchantId, currency: payout.currency } },
        create: { merchantId: payout.merchantId, currency: payout.currency, balance: payout.amount },
        update: { balance: { increment: payout.amount } },
      });

      await tx.ledgers.create({
        data: {
          publicId: generatePublicId('pf-ledger'),
          account: 'MERCHANT',
          accountKey: payout.merchantId,
          merchantId: payout.merchantId,
          currency: payout.currency,
          amount: payout.amount,
          type: 'CREDIT',
          referenceId: `payout-reversal:${payout.publicId}`,
        },
      });

      // Mirror of the clearing CREDIT written at schedule time, so a failed
      // payout leaves the journal balanced rather than half-reversed.
      await tx.ledgers.create({
        data: {
          publicId: generatePublicId('pf-ledger'),
          account: 'MERCHANT_CLEARING',
          accountKey: payout.merchantId,
          merchantId: payout.merchantId,
          currency: payout.currency,
          amount: payout.amount,
          type: 'DEBIT',
          referenceId: `payout-reversal:${payout.publicId}`,
        },
      });
    });

    await this.webhooks.dispatchPayoutEvent({ payoutId: payout.id, type: 'PAYOUT_FAILED' });
    return this.get(payout.merchantId, publicId);
  }

  private present(payout: {
    publicId: string;
    amount: bigint;
    currency: string;
    status: PayoutStatus;
    externalRef: string | null;
    failureReason: string | null;
    processedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      publicId: payout.publicId,
      amount: toMajorNumber(payout.amount, payout.currency),
      currency: payout.currency,
      status: payout.status,
      externalRef: payout.externalRef,
      failureReason: payout.failureReason,
      processedAt: payout.processedAt,
      createdAt: payout.createdAt,
    };
  }
}