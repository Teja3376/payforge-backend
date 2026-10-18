import { Inject, Injectable } from '@nestjs/common';
import {
  AccountStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  TransactionStatus,
  type CardBrand,
  type WalletProvider,
} from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { assertIdempotencyKey, assertSamePayload } from '../../common/idempotency/idempotency';
import { logger } from '../../common/logger/logger';
import { PrismaService } from '../../database/prisma.service';
import { paginatedQuery } from '../../common/pagination/pagination';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { detailsFromSavedMethod, payloadHash, sanitizeDetails, type SafeMethodDetails } from './payload-hash';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import {
  presentTransaction,
  transactionInclude,
  type TransactionWithDetails,
} from './transaction.presenter';

@Injectable()
export class TransactionService {
  private readonly log = logger.child({ module: 'transactions' });

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {}

  /**
   * Attempt to collect against a payment.
   *
   * Ordering matters and is deliberate:
   *  1. Validate ownership and state.
   *  2. Resolve idempotency *before* contacting the bank.
   *  3. Take a row lock on the payment so two concurrent attempts on the same
   *     payment cannot both pass the "no open transaction" check.
   *  4. Call the bank, then commit. If the commit fails, void the charge —
   *     without that compensating call the bank holds money PayForge has no
   *     record of, and `BankPort` has no way to reconcile it later.
   */
  async createTransaction(input: {
    user: RequestUser;
    dto: CreateTransactionDto;
    idempotencyKey: string;
  }) {
    const { user, dto } = input;
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);

    if (user.status !== AccountStatus.ACTIVE) {
      throw ApiError.of(ErrorCode.ACCOUNT_SUSPENDED, 'Suspended users cannot pay.');
    }

    const payment = await this.prisma.payments.findUnique({
      where: { publicId: dto.paymentPublicId },
      include: { merchant: true },
    });
    if (!payment || payment.userId !== user.id) {
      throw ApiError.of(ErrorCode.PAYMENT_NOT_FOUND);
    }
    if (payment.merchant.status !== AccountStatus.ACTIVE) {
      throw ApiError.of(ErrorCode.MERCHANT_CANNOT_RECEIVE);
    }

    // Defence in depth on the money-moving path.
    //
    // `approveMerchant` gates activation on KYC, screening and provider
    // status, but that check runs once. A merchant activated before those
    // gates existed would never be re-examined, and the provider can restrict
    // a merchant at any time without PayForge being told. So the charge path
    // verifies the live-mode preconditions itself rather than trusting
    // `status === ACTIVE` as a proxy for them.
    if (payment.merchant.mode === 'LIVE') {
      const [kyc, provider] = await Promise.all([
        this.prisma.merchantKyc.findUnique({
          where: { merchantId: payment.merchantId },
          select: { status: true },
        }),
        this.prisma.merchantProviderAccount.findUnique({
          where: { merchantId: payment.merchantId },
          select: { chargesEnabled: true, onboardingStatus: true },
        }),
      ]);

      if (kyc?.status !== 'APPROVED') {
        this.log.error(
          { merchantId: payment.merchantId, kycStatus: kyc?.status ?? 'NONE' },
          'LIVE merchant without approved KYC — refusing the charge',
        );
        throw ApiError.of(
          ErrorCode.MERCHANT_CANNOT_RECEIVE,
          'This merchant is not currently able to receive payments. Contact support.',
        );
      }
      if (provider && !provider.chargesEnabled) {
        this.log.error(
          {
            merchantId: payment.merchantId,
            onboardingStatus: provider.onboardingStatus,
          },
          'LIVE merchant whose payment provider is not charging — refusing the charge',
        );
        throw ApiError.of(
          ErrorCode.MERCHANT_CANNOT_RECEIVE,
          'This merchant is not currently able to receive payments. Contact support.',
        );
      }
    }
    if (payment.expiresAt.getTime() <= Date.now() || payment.status === PaymentStatus.EXPIRED) {
      throw ApiError.of(ErrorCode.PAYMENT_EXPIRED);
    }
    if (
      payment.status === PaymentStatus.SUCCESS ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw ApiError.of(ErrorCode.PAYMENT_FINALIZED);
    }
    if (payment.status === PaymentStatus.CANCELLED) {
      throw ApiError.of(ErrorCode.PAYMENT_FINALIZED, 'This payment was cancelled.');
    }

    const gatewayToken = dto.gatewayToken;

    const savedMethod = dto.savedPaymentMethodId
      ? await this.prisma.savedPaymentMethod.findUnique({
          where: { publicId: dto.savedPaymentMethodId },
        })
      : null;
    if (dto.savedPaymentMethodId && (!savedMethod || savedMethod.merchantId !== payment.merchantId)) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'That saved payment method is not available.');
    }
    if (savedMethod && savedMethod.status !== 'ACTIVE') {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'That saved payment method has been disabled.',
      );
    }

    // Card details can come from three places, in priority order:
    //   1. a single-use token straight from the hosted-fields iframe
    //   2. a card previously saved against this merchant
    //   3. raw details in the request body (legacy, in PCI scope)
    //
    // (1) and (2) mean no PAN exists anywhere near this server. (3) does not.
    const details: SafeMethodDetails = gatewayToken
      ? tokenDetails(dto, gatewayToken)
      : savedMethod
        ? detailsFromSavedMethod(savedMethod)
        : sanitizeDetails({
            method: dto.method,
            card: dto.card,
            upi: dto.upi,
            netBanking: dto.netBanking,
            wallet: dto.wallet,
            // Derived from the *merchant's* environment, not the payer's
            // credential: the payer holds a session JWT and has no mode of
            // their own, and a sandbox merchant must still be able to take
            // test cards.
            livemode: payment.merchant.mode === 'LIVE',
          });

    const hash = payloadHash({
      paymentPublicId: dto.paymentPublicId,
      method: dto.method,
      details,
    });

    // Idempotency is checked before the bank call so a retry never charges twice.
    const existing = await this.prisma.transactions.findUnique({
      where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
      include: transactionInclude,
    });
    if (existing) {
      assertSamePayload(existing.payloadHash, hash);
      return { replayed: true, transaction: presentTransaction(existing) };
    }

    const openAttempt = await this.prisma.transactions.findFirst({
      where: {
        paymentId: payment.id,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.SUCCESS] },
      },
      select: { id: true },
    });
    if (openAttempt) {
      throw ApiError.of(ErrorCode.PAYMENT_HAS_OPEN_TRANSACTION);
    }

    let gatewayRef: string;
    try {
      const charge = await this.bank.createCharge({
        amountMinor: payment.settlementAmount,
        currency: payment.settlementCurrency,
        idempotencyKey,
        paymentToken: gatewayToken ?? savedMethod?.gatewayToken,
        method: dto.method,
      });
      gatewayRef = charge.gatewayRef;
    } catch (error) {
      // The original swallowed this in a bare `catch {}`, making a bank outage
      // undiagnosable. Log the cause and surface a coded error.
      this.log.error(
        { err: error, paymentId: payment.publicId },
        'bank charge failed',
      );
      throw ApiError.of(
        ErrorCode.BANK_CHARGE_FAILED,
        'The bank declined this charge. No money has been taken.',
        { cause: error },
      );
    }

    try {
      const created = await this.prisma.$transaction(
        async (tx) => {
          // Serialise concurrent attempts on this payment. Without it, two
          // requests with different idempotency keys both observe "no open
          // attempt" and both charge. The partial unique index
          // Transactions_one_open_per_payment is the backstop if this is ever
          // bypassed; the resulting P2002 is mapped to a 409 below.
          await tx.$queryRaw`SELECT "id" FROM "Payments" WHERE "id" = ${payment.id} FOR UPDATE`;

          const stale = await tx.transactions.findFirst({
            where: {
              paymentId: payment.id,
              status: { in: [TransactionStatus.PENDING, TransactionStatus.SUCCESS] },
            },
            select: { id: true },
          });
          if (stale) {
            throw ApiError.of(ErrorCode.PAYMENT_HAS_OPEN_TRANSACTION);
          }

          const data = {
            publicId: generatePublicId('pf-trx'),
            userId: user.id,
            paymentId: payment.id,
            status: TransactionStatus.PENDING,
            gatewayRef,
            idempotencyKey,
            payloadHash: hash,
            currency: payment.settlementCurrency,
            amount: payment.settlementAmount,
            ...this.detailCreate(details),
          } as Prisma.TransactionsUncheckedCreateInput;

          const transaction = await tx.transactions.create({
            data,
            include: transactionInclude,
          });

          await tx.payments.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.PENDING },
          });

          return transaction;
        },
        { maxWait: 10000, timeout: 20000 },
      );
      return { replayed: false, transaction: presentTransaction(created) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Either the idempotency key raced, or the open-transaction index
        // fired. Both are recoverable: re-read and decide.
        const raced = await this.prisma.transactions.findUnique({
          where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
          include: transactionInclude,
        });
        if (raced) {
          assertSamePayload(raced.payloadHash, hash);
          return { replayed: true, transaction: presentTransaction(raced) };
        }
        throw ApiError.of(ErrorCode.PAYMENT_HAS_OPEN_TRANSACTION);
      }

      // The bank already holds this charge. Release it, or the payer is charged
      // for a transaction PayForge has no record of.
      if (error instanceof ApiError) {
        await this.voidOrphanedCharge(gatewayRef, error.code);
        throw error;
      }
      await this.voidOrphanedCharge(gatewayRef, ErrorCode.INTERNAL_ERROR);
      throw error;
    }
  }

  private async voidOrphanedCharge(gatewayRef: string, reason: string) {
    try {
      await this.bank.voidCharge({ gatewayRef, reason });
      this.log.warn({ gatewayRef, reason }, 'voided a charge whose transaction failed to commit');
    } catch (error) {
      this.log.error(
        { err: error, gatewayRef },
        'could not void orphaned charge — reconciliation needed',
      );
    }
  }

  async getTransaction(user: RequestUser, publicId: string) {
    const transaction = await this.prisma.transactions.findUnique({
      where: { publicId },
      include: transactionInclude,
    });
    if (!transaction || !this.canSee(user, transaction)) {
      throw ApiError.of(ErrorCode.TRANSACTION_NOT_FOUND);
    }
    return presentTransaction(transaction);
  }

  async listTransactions(user: RequestUser, params: { limit: number; cursor?: string; order?: 'asc' | 'desc' }) {
    return paginatedQuery<TransactionWithDetails, ReturnType<typeof presentTransaction>>({
      scope: this.scope(user),
      query: (where, take, orderBy) =>
        this.prisma.transactions.findMany({
          where: where as Prisma.TransactionsWhereInput,
          include: transactionInclude,
          orderBy: orderBy as Prisma.TransactionsOrderByWithRelationInput[],
          take,
        }),
      present: presentTransaction,
      ...params,
    });
  }

  /**
   * Merchant scoping.
   *
   * `?? 'none'` is a UUID sentinel that cannot match any row. Using
   * `undefined` here would mean "no filter" to Prisma and would silently return
   * every transaction on the platform — a fail-open leak.
   */
  private scope(user: RequestUser): Prisma.TransactionsWhereInput {
    if (user.role === Role.SUPER_ADMIN) {
      return {};
    }
    if (user.role === Role.MERCHANT) {
      return { payment: { merchantId: user.merchantId ?? 'none' } };
    }
    return { userId: user.id };
  }

  private canSee(
    user: RequestUser,
    transaction: { payment: { userId: string; merchantId: string } },
  ) {
    if (user.role === Role.SUPER_ADMIN) {
      return true;
    }
    if (user.role === Role.MERCHANT) {
      return transaction.payment.merchantId === user.merchantId;
    }
    return transaction.payment.userId === user.id;
  }

/**
   * Nested create payload for the method-detail tables.
   *
   * Switching on `details.method` (rather than `dto.method`) lets TypeScript
   * narrow the union, so the sanitised fields are read without casting and a
   * mismatch between method and stored details is a compile error.
   */
  private detailCreate(details: SafeMethodDetails) {
    switch (details.method) {
      case PaymentMethod.CARD:
        return {
          method: PaymentMethod.CARD,
          cardDetail: {
            create: {
              holderName: details.holderName,
              brand: details.brand as CardBrand,
              last4: details.last4,
              expiryMonth: details.expiryMonth,
              expiryYear: details.expiryYear,
            },
          },
        };
      case PaymentMethod.UPI:
        return { method: PaymentMethod.UPI, upiDetail: { create: { vpa: details.vpa } } };
      case PaymentMethod.NET_BANKING:
        return {
          method: PaymentMethod.NET_BANKING,
          netBankingDetail: { create: { bankCode: details.bankCode } },
        };
      case PaymentMethod.WALLET:
        return {
          method: PaymentMethod.WALLET,
          walletDetail: { create: { provider: details.provider as WalletProvider } },
        };
    }
  }
}

/**
 * Card details for a charge authorised by a gateway token.
 *
 * The PAN was captured inside the provider's iframe and never reached this
 * server, so there is nothing to sanitise. Only placeholder display metadata is
 * stored; real brand and last4 arrive on the settlement callback.
 */
function tokenDetails(dto: CreateTransactionDto, gatewayToken: string): SafeMethodDetails {
  return {
    method: PaymentMethod.CARD,
    holderName: dto.card?.holderName ?? '',
    brand: 'OTHER',
    last4: gatewayToken.slice(-4),
    expiryMonth: 1,
    expiryYear: 2000,
  };
}
