import { Injectable } from '@nestjs/common';
import {
  AccountStatus,
  ActorType,
  KeyMode,
  LedgerAccount,
  LedgerType,
  Prisma,
  ProviderOnboarding,
  ResolutionAction,
  ResolutionSubject,
} from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { toMajorNumber } from '../../common/money/money';
import { paginatedQuery } from '../../common/pagination/pagination';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { SettlementService } from '../webhooks/settlement.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
  ) {}

  /**
   * Platform overview.
   *
   * Aggregated in the database rather than by loading whole tables into Node:
   * the original issued three unbounded `findMany` calls and summed them in
   * memory, which degrades linearly and is the endpoint most likely to time
   * out once there is real volume.
   */
  async overview() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [feeAllTime, feeThisMonth, merchantCount, paymentCount] = await Promise.all([
      this.prisma.ledgers.groupBy({
        by: ['currency', 'type'],
        where: { account: LedgerAccount.PLATFORM },
        _sum: { amount: true },
      }),
      this.prisma.ledgers.groupBy({
        by: ['currency', 'type'],
        where: { account: LedgerAccount.PLATFORM, createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      this.prisma.merchants.count({ where: { deletedAt: null } }),
      this.prisma.payments.count({ where: { status: 'SUCCESS' } }),
    ]);

    return {
      platformFeeAllTime: this.moneyMap(
        new Map(
          feeAllTime.map((row) => [
            row.currency,
            (row._sum.amount ?? 0n) * (row.type === LedgerType.DEBIT ? -1n : 1n),
          ]),
        ),
      ),
      platformFeeThisMonth: this.moneyMap(
        new Map(
          feeThisMonth.map((row) => [
            row.currency,
            (row._sum.amount ?? 0n) * (row.type === LedgerType.DEBIT ? -1n : 1n),
          ]),
        ),
      ),
      merchants: { total: merchantCount },
      payments: { succeeded: paymentCount },
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Per-merchant revenue.
   *
   * Reports **net** (post-fee) figures read from the ledger, not gross
   * `settlementAmount`. The original summed gross settlement amounts while the
   * merchant balance was credited net, so the admin dashboard overstated every
   * merchant's earnings by the fee rate and never reconciled with
   * `GET /merchants/me`.
   */
  async merchantRevenue(publicId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      select: { id: true, publicId: true, name: true, createdAt: true, status: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }

    const now = new Date();
    const rows = await this.prisma.ledgers.groupBy({
      by: ['currency', 'type'],
      where: { account: LedgerAccount.MERCHANT, merchantId: merchant.id },
      _sum: { amount: true },
    });

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthRows = await this.prisma.ledgers.groupBy({
      by: ['currency', 'type'],
      where: {
        account: LedgerAccount.MERCHANT,
        merchantId: merchant.id,
        createdAt: { gte: monthStart },
      },
      _sum: { amount: true },
    });

    const months = Math.max(
      1,
      (now.getUTCFullYear() - merchant.createdAt.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - merchant.createdAt.getUTCMonth()) +
        1,
    );

    const allTime = new Map<string, bigint>();
    for (const row of rows) {
      allTime.set(
        row.currency,
        (allTime.get(row.currency) ?? 0n) +
          (row._sum.amount ?? 0n) * (row.type === LedgerType.DEBIT ? -1n : 1n),
      );
    }
    const thisMonth = new Map<string, bigint>();
    for (const row of monthRows) {
      thisMonth.set(
        row.currency,
        (thisMonth.get(row.currency) ?? 0n) +
          (row._sum.amount ?? 0n) * (row.type === LedgerType.DEBIT ? -1n : 1n),
      );
    }

    const currencies = [...new Set([...allTime.keys(), ...thisMonth.keys()])].sort();
    return {
      publicId: merchant.publicId,
      name: merchant.name,
      status: merchant.status,
      months,
      // Net of fees, so this ties out to the merchant's own balance.
      byCurrency: currencies.map((currency) => ({
        currency,
        netAllTime: toMajorNumber(allTime.get(currency) ?? 0n, currency),
        netThisMonth: toMajorNumber(thisMonth.get(currency) ?? 0n, currency),
        netAveragePerMonth: toMajorNumber((allTime.get(currency) ?? 0n) / BigInt(months), currency),
      })),
    };
  }

  async fees(params: { limit: number; cursor?: string; account?: 'MERCHANT' | 'PLATFORM'; merchantId?: string }) {
    const account = params.account ?? LedgerAccount.PLATFORM;
    return paginatedQuery({
      scope: { account, ...(params.merchantId ? { merchantId: params.merchantId } : {}) },
      query: (where, take, orderBy) =>
        this.prisma.ledgers.findMany({
          where: where as Prisma.LedgersWhereInput,
          include: { merchant: { select: { publicId: true, name: true } } },
          orderBy: orderBy as Prisma.LedgersOrderByWithRelationInput[],
          take,
        }),
      present: (entry) => ({
        publicId: entry.publicId,
        account: entry.account,
        merchant: entry.merchant
          ? { publicId: entry.merchant.publicId, name: entry.merchant.name }
          : null,
        currency: entry.currency,
        amount: toMajorNumber(entry.amount, entry.currency),
        type: entry.type,
        balanceAfter:
          entry.balanceAfter == null ? null : toMajorNumber(entry.balanceAfter, entry.currency),
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
      }),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /**
   * Audit trail.
   *
   * The `Resolution` table was written on every suspend/restore/refund and had
   * **no read endpoint** — the audit log was effectively write-only. An admin
   * investigating a dispute had no way to see who did what.
   */
  async resolutions(params: { limit: number; cursor?: string; subjectPublicId?: string; action?: string }) {
    return paginatedQuery({
      scope: {
        ...(params.subjectPublicId ? { subjectPublicId: params.subjectPublicId } : {}),
        ...(params.action ? { action: params.action } : {}),
      },
      query: (where, take, orderBy) =>
        this.prisma.resolution.findMany({
          where: where as Prisma.ResolutionWhereInput,
          include: { actor: { select: { publicId: true, email: true } } },
          orderBy: orderBy as Prisma.ResolutionOrderByWithRelationInput[],
          take,
        }),
      present: (entry) => ({
        publicId: entry.publicId,
        actor: entry.actor ? { publicId: entry.actor.publicId, email: entry.actor.email } : null,
        actorType: entry.actorType,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectPublicId: entry.subjectPublicId,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      }),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /** Payer lookup by public id — previously there was no user list at all. */
  async listUsers(params: { limit: number; cursor?: string; status?: string }) {
    return paginatedQuery({
      scope: params.status ? { status: params.status } : {},
      query: (where, take, orderBy) =>
        this.prisma.users.findMany({
          where: where as Prisma.UsersWhereInput,
          select: {
            id: true,
            publicId: true,
            email: true,
            role: true,
            status: true,
            countryCode: true,
            createdAt: true,
            lastLoginAt: true,
            merchant: { select: { publicId: true } },
          },
          orderBy: orderBy as Prisma.UsersOrderByWithRelationInput[],
          take,
        }),
      present: (user) => ({
        publicId: user.publicId,
        email: user.email,
        role: user.role,
        status: user.status,
        countryCode: user.countryCode,
        merchantPublicId: user.merchant?.publicId ?? null,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      }),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /**
   * Paginated merchant list.
   *
   * Unlike the fee summary, this includes merchants with no payment history —
   * an empty `byCurrency` row used to be indistinguishable from "zero revenue".
   */
  async list(params: { limit: number; cursor?: string; order?: 'asc' | 'desc'; status?: string }) {
    return paginatedQuery({
      scope: params.status ? { status: params.status } : {},
      query: (where, take, orderBy) =>
        this.prisma.merchants.findMany({
          where: where as Prisma.MerchantsWhereInput,
          select: {
            id: true,
            createdAt: true,
            publicId: true,
            name: true,
            email: true,
            status: true,
            mode: true,
            countryCode: true,
            defaultFeeBasisPoints: true,
            balances: { select: { currency: true, balance: true, pending: true } },
          },
          orderBy: orderBy as Prisma.MerchantsOrderByWithRelationInput[],
          take,
        }),
      present: (merchant) => ({
        publicId: merchant.publicId,
        name: merchant.name,
        email: merchant.email,
        status: merchant.status,
        mode: merchant.mode,
        countryCode: merchant.countryCode,
        feeBasisPoints: merchant.defaultFeeBasisPoints,
        balances: merchant.balances.map((balance) => ({
          currency: balance.currency,
          amount: toMajorNumber(balance.balance, balance.currency),
          pending: toMajorNumber(balance.pending, balance.currency),
        })),
        createdAt: merchant.createdAt,
      }),
      limit: params.limit,
      cursor: params.cursor,
      order: params.order,
    });
  }

  suspendMerchant(actorId: string, publicId: string) {
    return this.setMerchantStatus(actorId, publicId, AccountStatus.SUSPENDED, ResolutionAction.SUSPEND_MERCHANT);
  }

  restoreMerchant(actorId: string, publicId: string) {
    return this.setMerchantStatus(actorId, publicId, AccountStatus.ACTIVE, ResolutionAction.RESTORE_MERCHANT);
  }

  /** Activate a merchant that self-registered into PENDING_REVIEW. */
  async approveMerchant(actorId: string, publicId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      include: { kyc: true, risk: true, providerAccount: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }

    // Approving inside PayForge is not the same as being approved by a bank or
    // payment provider. This was previously an unconditional status flip: a
    // brand-new account with no KYC on file went ACTIVE in one call and could
    // then take real money.
    if (!merchant.kyc || merchant.kyc.status !== 'APPROVED') {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'KYC must be approved before this merchant can be activated.',
        { meta: { kycStatus: merchant.kyc?.status ?? 'NOT_STARTED' } },
      );
    }
    if (!merchant.risk?.sanctionsChecked || !merchant.risk?.pepChecked) {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'Sanctions and PEP screening must both be complete before activation.',
        {
          meta: {
            sanctionsChecked: merchant.risk?.sanctionsChecked ?? false,
            pepChecked: merchant.risk?.pepChecked ?? false,
          },
        },
      );
    }
    // A merchant can be onboarded in PayForge and still be restricted at the
    // provider. Recording the external state is what stops us taking money for
    // someone the PSP will not actually process.
    if (
      merchant.providerAccount &&
      (!merchant.providerAccount.chargesEnabled || !merchant.providerAccount.payoutsEnabled)
    ) {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'The payment provider has not enabled charging and payouts for this merchant.',
        {
          meta: {
            chargesEnabled: merchant.providerAccount.chargesEnabled,
            payoutsEnabled: merchant.providerAccount.payoutsEnabled,
            onboardingStatus: merchant.providerAccount.onboardingStatus,
          },
        },
      );
    }

    return this.setMerchantStatus(
      actorId,
      publicId,
      AccountStatus.ACTIVE,
      ResolutionAction.APPROVE_MERCHANT,
    );
  }

  /**
   * Decide a KYC submission.
   *
   * Until this existed, KYC could be submitted but never approved or rejected:
   * the only write to `merchantKyc` anywhere forced `SUBMITTED`, so
   * KycStatus.APPROVED and .REJECTED were unreachable states and
   * reviewedAt / reviewedById were never populated.
   */
  async reviewKyc(
    actorId: string,
    publicId: string,
    dto: { decision: 'APPROVE' | 'REJECT'; reason?: string; reviewNotes?: string },
  ) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      include: { kyc: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (!merchant.kyc || merchant.kyc.status !== 'SUBMITTED') {
      throw ApiError.of(
        ErrorCode.ALREADY_IN_STATE,
        'This merchant has no KYC submission awaiting review.',
        { meta: { kycStatus: merchant.kyc?.status ?? 'NOT_STARTED' } },
      );
    }
    if (dto.decision === 'REJECT' && !dto.reason) {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'A rejection reason is required and is shown to the merchant.',
      );
    }

    const approved = dto.decision === 'APPROVE';

    await this.prisma.$transaction(async (tx) => {
      await tx.merchantKyc.update({
        where: { merchantId: merchant.id },
        data: {
          status: approved ? 'APPROVED' : 'REJECTED',
          rejectionReason: approved ? null : dto.reason,
          reviewNotes: dto.reviewNotes ?? null,
          reviewedAt: new Date(),
          reviewedById: actorId,
        },
      });
      await tx.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          actorType: ActorType.USER,
          action: approved ? ResolutionAction.KYC_APPROVED : ResolutionAction.KYC_REJECTED,
          subjectType: ResolutionSubject.MERCHANT,
          subjectPublicId: publicId,
          metadata: {
            from: 'SUBMITTED',
            to: approved ? 'APPROVED' : 'REJECTED',
            ...(dto.reason ? { reason: dto.reason } : {}),
          },
        },
      });
    });

    return this.getMerchantKyc(publicId);
  }

  /** The merchant's KYC state as recorded after a review decision. */
  private async getMerchantKyc(publicId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      include: { kyc: true, risk: true, providerAccount: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    return {
      publicId: merchant.publicId,
      status: merchant.status,
      mode: merchant.mode,
      kyc: merchant.kyc
        ? {
            status: merchant.kyc.status,
            legalName: merchant.kyc.legalName,
            registrationNumber: merchant.kyc.registrationNumber,
            rejectionReason: merchant.kyc.rejectionReason,
            submittedAt: merchant.kyc.submittedAt,
            reviewedAt: merchant.kyc.reviewedAt,
          }
        : null,
      risk: merchant.risk
        ? {
            riskScore: merchant.risk.riskScore,
            sanctionsChecked: merchant.risk.sanctionsChecked,
            pepChecked: merchant.risk.pepChecked,
            chargebackRate: merchant.risk.chargebackRate,
          }
        : null,
      providerAccount: merchant.providerAccount
        ? {
            provider: merchant.providerAccount.provider,
            providerAccountId: merchant.providerAccount.providerAccountId,
            onboardingStatus: merchant.providerAccount.onboardingStatus,
            chargesEnabled: merchant.providerAccount.chargesEnabled,
            payoutsEnabled: merchant.providerAccount.payoutsEnabled,
          }
        : null,
    };
  }

  /**
   * Move a merchant between TEST and LIVE.
   *
   * `Merchants.mode` had no write site anywhere in the codebase, so it stayed
   * TEST forever and `livemode: payment.merchant.mode === 'LIVE'` was
   * permanently false — the test-BIN block was unreachable and no merchant
   * could be promoted to a live environment even by hand.
   *
   * Promoting to LIVE additionally requires the provider to have enabled
   * charging and payouts, since that is the system that will actually move the
   * money.
   */
  async setMerchantMode(actorId: string, publicId: string, mode: KeyMode) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      include: { providerAccount: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (merchant.mode === mode) {
      throw ApiError.of(ErrorCode.ALREADY_IN_STATE, `This merchant is already in ${mode} mode.`);
    }

    if (mode === 'LIVE') {
      if (merchant.status !== AccountStatus.ACTIVE) {
        throw ApiError.of(
          ErrorCode.VALIDATION_FAILED,
          'The merchant must be active before it can go live.',
        );
      }
      if (
        !merchant.providerAccount?.chargesEnabled ||
        !merchant.providerAccount?.payoutsEnabled
      ) {
        throw ApiError.of(
          ErrorCode.VALIDATION_FAILED,
          'The payment provider must enable charging and payouts before this merchant can go live.',
          {
            meta: {
              chargesEnabled: merchant.providerAccount?.chargesEnabled ?? false,
              payoutsEnabled: merchant.providerAccount?.payoutsEnabled ?? false,
              onboardingStatus: merchant.providerAccount?.onboardingStatus ?? 'NOT_STARTED',
            },
          },
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.merchants.update({ where: { id: merchant.id }, data: { mode } }),
      this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          actorType: ActorType.USER,
          action: ResolutionAction.SET_MERCHANT_MODE,
          subjectType: ResolutionSubject.MERCHANT,
          subjectPublicId: publicId,
          metadata: { from: merchant.mode, to: mode },
        },
      }),
    ]);

    return { publicId, mode };
  }

  /** Record the risk and screening state that activation is gated on. */
  async setMerchantRisk(
    actorId: string,
    publicId: string,
    input: {
      riskScore?: number;
      sanctionsChecked?: boolean;
      pepChecked?: boolean;
      chargebackRate?: number;
    },
  ) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    const now = new Date();

    const risk = await this.prisma.merchantRisk.upsert({
      where: { merchantId: merchant.id },
      create: {
        merchantId: merchant.id,
        riskScore: input.riskScore ?? 0,
        sanctionsChecked: input.sanctionsChecked ?? false,
        sanctionsCheckedAt: input.sanctionsChecked ? now : null,
        pepChecked: input.pepChecked ?? false,
        pepCheckedAt: input.pepChecked ? now : null,
        chargebackRate: input.chargebackRate ?? 0,
        chargebackUpdatedAt: input.chargebackRate != null ? now : null,
      },
      update: {
        ...(input.riskScore != null ? { riskScore: input.riskScore } : {}),
        ...(input.sanctionsChecked != null
          ? { sanctionsChecked: input.sanctionsChecked, sanctionsCheckedAt: now }
          : {}),
        ...(input.pepChecked != null
          ? { pepChecked: input.pepChecked, pepCheckedAt: now }
          : {}),
        ...(input.chargebackRate != null
          ? { chargebackRate: input.chargebackRate, chargebackUpdatedAt: now }
          : {}),
      },
    });

    await this.prisma.resolution.create({
      data: {
        publicId: generatePublicId('pf-res'),
        actorId,
        actorType: ActorType.USER,
        action: ResolutionAction.SET_MERCHANT_RISK,
        subjectType: ResolutionSubject.MERCHANT,
        subjectPublicId: publicId,
        metadata: input as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      publicId: merchant.publicId,
      riskScore: risk.riskScore,
      sanctionsChecked: risk.sanctionsChecked,
      pepChecked: risk.pepChecked,
      chargebackRate: risk.chargebackRate,
    };
  }

  /**
   * Record the payment provider's own view of a merchant.
   *
   * This is deliberately separate from `status`. The provider can restrict or
   * disable a merchant at any time, and PayForge must be able to reflect that
   * without an operator editing the database.
   */
  async setProviderAccount(
    actorId: string,
    publicId: string,
    input: {
      provider: string;
      providerAccountId?: string;
      onboardingStatus: ProviderOnboarding;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      requirementsDue?: string;
    },
  ) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }

    const account = await this.prisma.merchantProviderAccount.upsert({
      where: { merchantId: merchant.id },
      create: {
        publicId: generatePublicId('pf-ppa'),
        merchantId: merchant.id,
        provider: input.provider,
        providerAccountId: input.providerAccountId ?? null,
        onboardingStatus: input.onboardingStatus,
        chargesEnabled: input.chargesEnabled,
        payoutsEnabled: input.payoutsEnabled,
        requirementsDue: input.requirementsDue ?? null,
        lastSyncedAt: new Date(),
      },
      update: {
        provider: input.provider,
        ...(input.providerAccountId != null
          ? { providerAccountId: input.providerAccountId }
          : {}),
        onboardingStatus: input.onboardingStatus,
        chargesEnabled: input.chargesEnabled,
        payoutsEnabled: input.payoutsEnabled,
        requirementsDue: input.requirementsDue ?? null,
        lastSyncedAt: new Date(),
      },
    });

    await this.prisma.resolution.create({
      data: {
        publicId: generatePublicId('pf-res'),
        actorId,
        actorType: ActorType.USER,
        action: ResolutionAction.SET_PROVIDER_ACCOUNT,
        subjectType: ResolutionSubject.MERCHANT,
        subjectPublicId: publicId,
        metadata: {
          provider: input.provider,
          onboardingStatus: input.onboardingStatus,
          chargesEnabled: input.chargesEnabled,
          payoutsEnabled: input.payoutsEnabled,
        },
      },
    });

    return account;
  }

  suspendUser(actorId: string, publicId: string) {
    return this.setUserStatus(actorId, publicId, AccountStatus.SUSPENDED, ResolutionAction.SUSPEND_USER);
  }

  restoreUser(actorId: string, publicId: string) {
    return this.setUserStatus(actorId, publicId, AccountStatus.ACTIVE, ResolutionAction.RESTORE_USER);
  }

  async refund(input: {
    actorId: string;
    actorType: ActorType;
    paymentPublicId: string;
    amountMinor?: bigint;
    currency: string;
    reason?: string;
    idempotencyKey: string;
  }) {
    return this.settlement.refund({
      paymentPublicId: input.paymentPublicId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      actorType: input.actorType,
    });
  }

  private async setMerchantStatus(
    actorId: string,
    publicId: string,
    status: AccountStatus,
    action: ResolutionAction,
  ) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (merchant.status === status) {
      throw ApiError.of(
        ErrorCode.ALREADY_IN_STATE,
        `This merchant is already ${status === 'ACTIVE' ? 'active' : status.toLowerCase()}.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.merchants.update({ where: { id: merchant.id }, data: { status } }),
      this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          actorType: ActorType.USER,
          action,
          subjectType: ResolutionSubject.MERCHANT,
          subjectPublicId: publicId,
          metadata: { from: merchant.status, to: status },
        },
      }),
    ]);

    return { publicId, status };
  }

  private async setUserStatus(
    actorId: string,
    publicId: string,
    status: AccountStatus,
    action: ResolutionAction,
  ) {
    const user = await this.prisma.users.findUnique({ where: { publicId } });
    if (!user) {
      throw ApiError.of(ErrorCode.USER_NOT_FOUND);
    }
    if (user.status === status) {
      throw ApiError.of(ErrorCode.ALREADY_IN_STATE, `This user is already ${status.toLowerCase()}.`);
    }

    await this.prisma.$transaction([
      this.prisma.users.update({ where: { id: user.id }, data: { status } }),
      this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          actorType: ActorType.USER,
          action,
          subjectType: ResolutionSubject.USER,
          subjectPublicId: publicId,
          metadata: { from: user.status, to: status },
        },
      }),
    ]);

    return { publicId, status };
  }

  private moneyMap(values: Map<string, bigint>) {
    return [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => ({ currency, amount: toMajorNumber(amount, currency) }));
  }
}