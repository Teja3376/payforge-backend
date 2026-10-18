import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { toMajorNumber } from '../../common/money/money';
import { paginatedQuery } from '../../common/pagination/pagination';
import { PrismaService } from '../../database/prisma.service';
import type { KycSubmissionDto } from './dto/merchant.dto';

type KycSubmissionPayload = Partial<Record<keyof KycSubmissionDto, string>>;

const merchantSelect = {
  id: true,
  publicId: true,
  name: true,
  email: true,
  status: true,
  mode: true,
  countryCode: true,
  settlementCurrency: true,
  settlementDelayDays: true,
  defaultFeeBasisPoints: true,
  createdAt: true,
  balances: { select: { currency: true, balance: true, pending: true } },
  kyc: true,
  feeSchedule: true,
} satisfies Prisma.MerchantsSelect;

type MerchantRow = Prisma.MerchantsGetPayload<{ select: typeof merchantSelect }>;

@Injectable()
export class MerchantService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: RequestUser) {
    if (!user.merchantId) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    const merchant = await this.prisma.merchants.findUnique({
      where: { id: user.merchantId },
      select: merchantSelect,
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    return this.present(merchant);
  }

  async getMerchant(user: RequestUser, publicId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      select: merchantSelect,
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    const owns = user.role === Role.MERCHANT && merchant.id === user.merchantId;
    if (user.role !== Role.SUPER_ADMIN && !owns) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    return this.present(merchant);
  }

  /** Paginated merchant list for the admin surface. */
  async list(params: { limit: number; cursor?: string; order?: 'asc' | 'desc'; status?: string }) {
    return paginatedQuery<MerchantRow, unknown>({
      scope: params.status ? { status: params.status } : {},
      query: (where, take, orderBy) =>
        this.prisma.merchants.findMany({
          where: where as Prisma.MerchantsWhereInput,
          select: merchantSelect,
          orderBy: orderBy as Prisma.MerchantsOrderByWithRelationInput[],
          take,
        }),
      present: (row) => this.present(row),
      limit: params.limit,
      cursor: params.cursor,
      order: params.order,
    });
  }

  async update(user: RequestUser, publicId: string, patch: { name?: string; countryCode?: string; settlementCurrency?: string }) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (user.role !== Role.SUPER_ADMIN && merchant.id !== user.merchantId) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (user.role !== Role.SUPER_ADMIN && patch.settlementCurrency) {
      throw ApiError.of(
        ErrorCode.FORBIDDEN,
        'Only an administrator can change the settlement currency.',
      );
    }

    const updated = await this.prisma.merchants.update({
      where: { id: merchant.id },
      data: patch,
      select: merchantSelect,
    });
    return this.present(updated);
  }

  async submitKyc(
    user: RequestUser,
    publicId: string,
    payload: KycSubmissionPayload,
  ) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (user.role !== Role.SUPER_ADMIN && merchant.id !== user.merchantId) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }

    await this.prisma.merchantKyc.upsert({
      where: { merchantId: merchant.id },
      create: { merchantId: merchant.id, ...payload, status: 'SUBMITTED', submittedAt: new Date() },
      update: { ...payload, status: 'SUBMITTED', submittedAt: new Date(), rejectionReason: null },
    });
    return this.getMerchant(user, publicId);
  }

  async setFeeSchedule(user: RequestUser, publicId: string, basisPoints: number) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (user.role !== Role.SUPER_ADMIN && merchant.id !== user.merchantId) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }

    await this.prisma.merchantFeeSchedule.upsert({
      where: { merchantId: merchant.id },
      create: { merchantId: merchant.id, basisPoints },
      update: { basisPoints },
    });
    await this.prisma.merchants.update({
      where: { id: merchant.id },
      data: { defaultFeeBasisPoints: basisPoints },
    });

    return this.getMerchant(user, publicId);
  }

  /**
   * Balance statement.
   *
   * Reads the append-only ledger rather than deriving from payments, so the
   * statement is the authoritative record and ties out to the balance.
   */
  async statement(user: RequestUser, params: { limit: number; cursor?: string; currency?: string }) {
    if (!user.merchantId) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    return paginatedQuery({
      scope: {
        merchantId: user.merchantId,
        account: 'MERCHANT',
        ...(params.currency ? { currency: params.currency.toUpperCase() } : {}),
      },
      query: (where, take, orderBy) =>
        this.prisma.ledgers.findMany({
          where: where as Prisma.LedgersWhereInput,
          orderBy: orderBy as Prisma.LedgersOrderByWithRelationInput[],
          take,
        }),
      present: (entry) => ({
        publicId: entry.publicId,
        currency: entry.currency,
        type: entry.type,
        amount: toMajorNumber(entry.amount, entry.currency),
        balanceAfter:
          entry.balanceAfter == null
            ? null
            : toMajorNumber(entry.balanceAfter, entry.currency),
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
      }),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  private present(merchant: MerchantRow) {
    return {
      publicId: merchant.publicId,
      name: merchant.name,
      email: merchant.email,
      status: merchant.status,
      mode: merchant.mode,
      countryCode: merchant.countryCode,
      settlementCurrency: merchant.settlementCurrency,
      settlementDelayDays: merchant.settlementDelayDays,
      feeBasisPoints: merchant.feeSchedule?.basisPoints ?? merchant.defaultFeeBasisPoints,
      feeSchedule: merchant.feeSchedule
        ? {
            basisPoints: merchant.feeSchedule.basisPoints,
            minFee: merchant.feeSchedule.minFeeMinor
              ? toMajorNumber(merchant.feeSchedule.minFeeMinor, merchant.settlementCurrency)
              : null,
            effectiveFrom: merchant.feeSchedule.effectiveFrom,
          }
        : null,
      kyc: merchant.kyc
        ? {
            status: merchant.kyc.status,
            legalName: merchant.kyc.legalName,
            registrationNumber: merchant.kyc.registrationNumber,
            taxId: merchant.kyc.taxId,
            countryCode: merchant.kyc.countryCode,
            addressLine1: merchant.kyc.addressLine1,
            city: merchant.kyc.city,
            submittedAt: merchant.kyc.submittedAt,
            reviewedAt: merchant.kyc.reviewedAt,
            rejectionReason: merchant.kyc.rejectionReason,
          }
        : { status: 'NOT_STARTED' },
      balances: [...merchant.balances]
        .sort((left, right) => left.currency.localeCompare(right.currency))
        .map((balance) => ({
          currency: balance.currency,
          amount: toMajorNumber(balance.balance, balance.currency),
          pending: toMajorNumber(balance.pending, balance.currency),
        })),
      createdAt: merchant.createdAt,
    };
  }
}