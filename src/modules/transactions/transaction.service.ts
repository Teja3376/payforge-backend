import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, PaymentMethod, PaymentStatus, Prisma, Role, TransactionStatus } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { PrismaService } from '../../database/prisma.service';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { validateCard } from './card-validation';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { payloadHash, SafeMethodDetails } from './payload-hash';
import { presentTransaction, transactionInclude } from './transaction.presenter';

@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {}

  async createTransaction(user: RequestUser, dto: CreateTransactionDto) {
    if (user.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Suspended users cannot pay');
    }

    const payment = await this.prisma.payments.findUnique({
      where: { publicId: dto.paymentPublicId },
      include: { merchant: true, transactions: { select: { status: true, idempotencyKey: true } } },
    });
    if (!payment || payment.userId !== user.id) {
      throw new NotFoundException('Payment not found');
    }
    if (payment.merchant.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Merchant cannot receive payments');
    }
    if (payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.REFUNDED) {
      throw new BadRequestException('Payment is already finalized');
    }

    const details = this.safeDetails(dto);
    const hash = payloadHash({
      paymentPublicId: dto.paymentPublicId,
      method: dto.method,
      details,
    });

    const existing = await this.prisma.transactions.findUnique({
      where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: dto.idempotencyKey } },
      include: transactionInclude,
    });
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new ConflictException('Idempotency key was already used with a different payload');
      }
      return { replay: true, body: presentTransaction(existing) };
    }

    const openAttempt = payment.transactions.some(
      (transaction) =>
        transaction.status === TransactionStatus.PENDING || transaction.status === TransactionStatus.SUCCESS,
    );
    if (openAttempt) {
      throw new ConflictException('Payment already has an open transaction');
    }

    let gatewayRef: string;
    try {
      const charge = await this.bank.createCharge();
      gatewayRef = charge.gatewayRef;
    } catch {
      throw new BadGatewayException('Bank charge failed');
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const transaction = await tx.transactions.create({
          data: {
            publicId: generatePublicId('pf-trx'),
            user: { connect: { id: user.id } },
            payment: { connect: { id: payment.id } },
            status: TransactionStatus.PENDING,
            gatewayRef,
            idempotencyKey: dto.idempotencyKey,
            payloadHash: hash,
            currency: payment.settlementCurrency,
            amount: payment.settlementAmount,
            ...this.detailCreate(dto, details),
          },
          include: transactionInclude,
        });
        await tx.payments.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.PENDING },
        });
        return transaction;
      }, { maxWait: 10000, timeout: 20000 });
      return { replay: false, body: presentTransaction(created) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.transactions.findUnique({
          where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: dto.idempotencyKey } },
          include: transactionInclude,
        });
        if (raced && raced.payloadHash === hash) {
          return { replay: true, body: presentTransaction(raced) };
        }
        throw new ConflictException('Idempotency key was already used with a different payload');
      }
      throw error;
    }
  }

  async getTransaction(user: RequestUser, publicId: string) {
    const transaction = await this.prisma.transactions.findUnique({
      where: { publicId },
      include: transactionInclude,
    });
    if (!transaction || !this.canSee(user, transaction.payment)) {
      throw new NotFoundException('Transaction not found');
    }
    return presentTransaction(transaction);
  }

  async listTransactions(user: RequestUser) {
    const transactions = await this.prisma.transactions.findMany({
      where: this.scope(user),
      include: transactionInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return transactions.map((transaction) => presentTransaction(transaction));
  }

  private scope(user: RequestUser): Prisma.TransactionsWhereInput {
    if (user.role === Role.SUPER_ADMIN) {
      return {};
    }
    if (user.role === Role.MERCHANT) {
      return { payment: { merchantId: user.merchantId ?? 'none' } };
    }
    return { userId: user.id };
  }

  private canSee(user: RequestUser, payment: { userId: string; merchantId: string }) {
    if (user.role === Role.SUPER_ADMIN) {
      return true;
    }
    if (user.role === Role.MERCHANT) {
      return payment.merchantId === user.merchantId;
    }
    return payment.userId === user.id;
  }

  private safeDetails(dto: CreateTransactionDto): SafeMethodDetails {
    switch (dto.method) {
      case PaymentMethod.CARD: {
        const card = validateCard(dto.card!.cardNumber, dto.card!.cvv);
        return {
          holderName: dto.card!.holderName,
          brand: card.brand,
          last4: card.last4,
          expiryMonth: dto.card!.expiryMonth,
          expiryYear: dto.card!.expiryYear,
        };
      }
      case PaymentMethod.UPI:
        return { vpa: dto.upi!.vpa };
      case PaymentMethod.NET_BANKING:
        return { bankCode: dto.netBanking!.bankCode };
      case PaymentMethod.WALLET:
        return { provider: dto.wallet!.provider };
    }
  }

  private detailCreate(dto: CreateTransactionDto, details: SafeMethodDetails) {
    switch (dto.method) {
      case PaymentMethod.CARD:
        return {
          method: dto.method,
          cardDetail: {
            create: {
              holderName: details.holderName!,
              brand: details.brand!,
              last4: details.last4!,
              expiryMonth: details.expiryMonth!,
              expiryYear: details.expiryYear!,
            },
          },
        };
      case PaymentMethod.UPI:
        return { method: dto.method, upiDetail: { create: { vpa: details.vpa! } } };
      case PaymentMethod.NET_BANKING:
        return { method: dto.method, netBankingDetail: { create: { bankCode: details.bankCode! } } };
      case PaymentMethod.WALLET:
        return { method: dto.method, walletDetail: { create: { provider: details.provider! } } };
    }
  }
}
