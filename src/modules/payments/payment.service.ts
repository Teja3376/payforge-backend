import { Injectable } from '@nestjs/common';
import { AccountStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { assertIdempotencyKey, assertSamePayload, stableHash } from '../../common/idempotency/idempotency';
import { toMajorNumber } from '../../common/money/money';
import { paginatedQuery } from '../../common/pagination/pagination';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { quoteSettlement } from '../fx/fx-math';
import { FxService } from '../fx/fx.service';

export const PAYMENT_TTL_MINUTES = 30;

const paymentSelect = {
  id: true,
  publicId: true,
  amount: true,
  currency: true,
  fxRateDate: true,
  usdRate: true,
  inrRate: true,
  settlementAmount: true,
  settlementCurrency: true,
  feeBasisPoints: true,
  status: true,
  refundedAmount: true,
  description: true,
  expiresAt: true,
  createdAt: true,
  userId: true,
  merchantId: true,
  merchant: { select: { publicId: true, name: true, status: true } },
  user: { select: { publicId: true } },
} satisfies Prisma.PaymentsSelect;

type PaymentRow = Prisma.PaymentsGetPayload<{ select: typeof paymentSelect }>;

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  /**
   * Create a payment (a quote that freezes FX and settles later).
   *
   * Idempotency is keyed per payer via `Idempotency-Key`. The original had no
   * idempotency at all, which made this — the single most retried call in the
   * product — the one write that could silently duplicate.
   */
  async createPayment(input: {
    user: RequestUser;
    dto: { merchantPublicId: string; amount: number; currency: string; description?: string; metadata?: Record<string, unknown> };
    idempotencyKey: string;
  }) {
    const { user, dto } = input;
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);

    if (user.status !== AccountStatus.ACTIVE) {
      throw ApiError.of(ErrorCode.ACCOUNT_SUSPENDED, 'Suspended users cannot pay.');
    }

    const hash = stableHash({
      merchantPublicId: dto.merchantPublicId,
      amount: dto.amount,
      currency: dto.currency.toUpperCase(),
    });

    const replayed = await this.prisma.payments.findUnique({
      where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
      select: paymentSelect,
    });
    if (replayed) {
      assertSamePayload(stableHash({
        merchantPublicId: replayed.merchant.publicId,
        amount: toMajorNumber(replayed.amount, replayed.currency),
        currency: replayed.currency,
      }), hash);
      return { replayed: true, payment: this.present(replayed) };
    }

    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId: dto.merchantPublicId },
    });
    if (!merchant || merchant.deletedAt) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (merchant.status !== AccountStatus.ACTIVE) {
      throw ApiError.of(ErrorCode.MERCHANT_CANNOT_RECEIVE);
    }

    const snapshot = await this.fx.ratesForToday();
    const quote = quoteSettlement({
      majorAmount: dto.amount,
      currency: dto.currency,
      merchantCountryCode: merchant.countryCode,
      merchantSettlementCurrency: merchant.settlementCurrency,
      rates: snapshot.rates,
    });

    const feeBasisPoints = await this.feeBasisPointsFor(merchant.id);

    try {
      const payment = await this.prisma.payments.create({
        data: {
          publicId: generatePublicId('pf-pay'),
          userId: user.id,
          merchantId: merchant.id,
          amount: quote.chargedMinor,
          currency: dto.currency.toUpperCase(),
          fxRateDate: snapshot.rateDate,
          usdRate: quote.usdRate,
          inrRate: quote.inrRate,
          settlementAmount: quote.settlementMinor,
          settlementCurrency: quote.settlementCurrency,
          feeBasisPoints,
          status: PaymentStatus.CREATED,
          idempotencyKey,
          description: dto.description,
          metadata: dto.metadata as object | undefined,
          expiresAt: new Date(Date.now() + PAYMENT_TTL_MINUTES * 60_000),
        },
        select: paymentSelect,
      });
      return { replayed: false, payment: this.present(payment) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.payments.findUnique({
          where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
          select: paymentSelect,
        });
        if (raced) {
          return { replayed: true, payment: this.present(raced) };
        }
      }
      throw error;
    }
  }

  async getPayment(user: RequestUser, publicId: string) {
    const payment = await this.prisma.payments.findUnique({
      where: { publicId },
      select: paymentSelect,
    });
    if (!payment || !this.canSee(user, payment)) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_FOUND);
    }
    return this.present(payment);
  }

  async listPayments(user: RequestUser, params: { limit: number; cursor?: string; order?: 'asc' | 'desc' }) {
    return paginatedQuery<PaymentRow, ReturnType<PaymentService['present']>>({
      scope: this.scope(user),
      query: (where, take, orderBy) =>
        this.prisma.payments.findMany({
          where: where as Prisma.PaymentsWhereInput,
          select: paymentSelect,
          orderBy: orderBy as Prisma.PaymentsOrderByWithRelationInput[],
          take,
        }),
      present: (row) => this.present(row),
      ...params,
    });
  }

  /** A payer may cancel their own unpaid payment; so may the merchant. */
  async cancelPayment(user: RequestUser, publicId: string, reason?: string) {
    const payment = await this.prisma.payments.findUnique({
      where: { publicId },
      select: { id: true, publicId: true, userId: true, merchantId: true },
    });
    if (!payment || !this.canSee(user, payment)) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_FOUND);
    }

    const changed = await this.prisma.payments.updateMany({
      where: {
        id: payment.id,
        status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
      },
      data: { status: PaymentStatus.CANCELLED, cancelledReason: reason },
    });
    if (changed.count === 0) {
      throw ApiError.of(ErrorCode.PAYMENT_FINALIZED, 'This payment can no longer be cancelled.');
    }

    return this.getPayment(user, publicId);
  }

  /**
   * A merchant-level fee schedule wins; otherwise the merchant's default.
   * Read inside the create path so a fee change takes effect on the next
   * payment rather than retroactively rewriting historical ones.
   */
  private async feeBasisPointsFor(merchantId: string): Promise<number> {
    const schedule = await this.prisma.merchantFeeSchedule.findUnique({
      where: { merchantId },
      select: { basisPoints: true },
    });
    if (schedule) {
      return schedule.basisPoints;
    }
    const merchant = await this.prisma.merchants.findUnique({
      where: { id: merchantId },
      select: { defaultFeeBasisPoints: true },
    });
    return merchant?.defaultFeeBasisPoints ?? 200;
  }

  private scope(user: RequestUser): Prisma.PaymentsWhereInput {
    if (user.role === Role.SUPER_ADMIN) {
      return {};
    }
    if (user.role === Role.MERCHANT) {
      return { merchantId: user.merchantId ?? 'none' };
    }
    return { userId: user.id };
  }

  /**
   * 404 rather than 403 on cross-tenant reads: a 403 confirms the resource
   * exists, which is itself an information leak about other merchants' volume.
   */
  private canSee(user: RequestUser, payment: { userId: string; merchantId: string }) {
    if (user.role === Role.SUPER_ADMIN) {
      return true;
    }
    if (user.role === Role.MERCHANT) {
      return payment.merchantId === user.merchantId;
    }
    return payment.userId === user.id;
  }

  private present(payment: PaymentRow) {
    return {
      publicId: payment.publicId,
      merchantPublicId: payment.merchant.publicId,
      merchantName: payment.merchant.name,
      payerPublicId: payment.user.publicId,
      amount: toMajorNumber(payment.amount, payment.currency),
      currency: payment.currency,
      fxRateDate: payment.fxRateDate.toISOString().slice(0, 10),
      usdRate: payment.usdRate.toString(),
      inrRate: payment.inrRate.toString(),
      settlementAmount: toMajorNumber(payment.settlementAmount, payment.settlementCurrency),
      settlementCurrency: payment.settlementCurrency,
      feeBasisPoints: payment.feeBasisPoints,
      refundedAmount: toMajorNumber(payment.refundedAmount, payment.settlementCurrency),
      description: payment.description,
      status: payment.status,
      expiresAt: payment.expiresAt,
      createdAt: payment.createdAt,
    };
  }
}