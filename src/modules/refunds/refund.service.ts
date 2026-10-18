import { Injectable } from '@nestjs/common';
import { ActorType, Prisma, type Refund } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { toMajorNumber } from '../../common/money/money';
import { paginatedQuery } from '../../common/pagination/pagination';
import { PrismaService } from '../../database/prisma.service';
import { SettlementService } from '../webhooks/settlement.service';

@Injectable()
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
  ) {}

  /**
   * Refund a payment, fully or partially.
   *
   * Idempotent per merchant. The cumulative refunded amount is bounded by a
   * database CHECK (`refundedAmount <= settlementAmount`), so concurrent
   * partial refunds cannot over-refund even if this logic were bypassed.
   */
  async create(input: {
    user: RequestUser;
    paymentId: string;
    amountMinor?: bigint;
    reason?: string;
    idempotencyKey: string;
  }) {
    const merchantId = this.merchantIdFor(input.user);
    const scope = this.scope(input.user, merchantId);

    const payment = await this.prisma.payments.findUnique({ where: { publicId: input.paymentId } });
    if (!payment || !scope(payment)) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_FOUND);
    }

    return this.settlement.refund({
      paymentPublicId: input.paymentId,
      amountMinor: input.amountMinor,
      currency: payment.settlementCurrency,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actorId: input.user.id,
      actorType: input.user.actorType ?? ActorType.USER,
    });
  }

  /**
   * A merchant only ever sees refunds against its own payments; a super admin
   * sees all. `paymentId` cannot be passed as a raw FK, so it is resolved to a
   * scoped lookup rather than filtered blindly.
   */
  async list(user: RequestUser, params: { limit: number; cursor?: string; paymentPublicId?: string }) {
    const scope: Prisma.RefundWhereInput =
      user.role === 'SUPER_ADMIN' ? {} : { merchantId: this.merchantIdFor(user) };

    if (params.paymentPublicId) {
      const payment = await this.prisma.payments.findUnique({
        where: { publicId: params.paymentPublicId },
        select: { id: true, merchantId: true, userId: true },
      });
      if (!payment || !this.scope(user, this.merchantIdFor(user))(payment)) {
        throw ApiError.of(ErrorCode.PAYMENT_NOT_FOUND);
      }
      return paginatedQuery({
        scope: { ...scope, paymentId: payment.id },
        query: (where, take, orderBy) =>
          this.prisma.refund.findMany({
            where: where as Prisma.RefundWhereInput,
            orderBy: orderBy as Prisma.RefundOrderByWithRelationInput[],
            take,
          }),
        present: (refund) => this.present(refund),
        limit: params.limit,
        cursor: params.cursor,
      });
    }

    return paginatedQuery({
      scope,
      query: (where, take, orderBy) =>
        this.prisma.refund.findMany({
          where: where as Prisma.RefundWhereInput,
          orderBy: orderBy as Prisma.RefundOrderByWithRelationInput[],
          take,
        }),
      present: (refund) => this.present(refund),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  async get(user: RequestUser, publicId: string) {
    const refund = await this.prisma.refund.findUnique({ where: { publicId } });
    if (!refund || refund.merchantId !== this.merchantIdFor(user)) {
      throw ApiError.of(ErrorCode.REFUND_NOT_FOUND);
    }
    return this.present(refund);
  }

  private merchantIdFor(user: RequestUser): string {
    if (!user.merchantId) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    return user.merchantId;
  }

  private scope(user: RequestUser, merchantId: string) {
    return (payment: { merchantId: string; userId: string }) => {
      if (user.role === 'SUPER_ADMIN') {
        return true;
      }
      if (user.role === 'MERCHANT') {
        return payment.merchantId === merchantId;
      }
      return payment.userId === user.id;
    };
  }

  private present(refund: Refund) {
    return {
      publicId: refund.publicId,
      paymentId: refund.paymentId,
      amount: toMajorNumber(refund.amount, refund.currency),
      currency: refund.currency,
      feeReversed: toMajorNumber(refund.feeReversed, refund.currency),
      netReversed: toMajorNumber(refund.netReversed, refund.currency),
      status: refund.status,
      gatewayRefundRef: refund.gatewayRefundRef,
      failureReason: refund.failureReason,
      reason: refund.reason,
      createdAt: refund.createdAt,
    };
  }
}