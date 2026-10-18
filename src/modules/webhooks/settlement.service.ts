import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerAccount, LedgerType, PaymentStatus, Prisma, TransactionStatus } from '@prisma/client';
import { splitFee } from '../../common/money/money';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { WebhookBody } from '../bank/webhook-signature';
import { presentTransaction, transactionInclude } from '../transactions/transaction.presenter';

@Injectable()
export class SettlementService {
  constructor(private readonly prisma: PrismaService) {}

  async settle(body: WebhookBody) {
    const existing = await this.prisma.transactions.findUnique({
      where: { gatewayRef: body.gatewayRef },
      include: transactionInclude,
    });
    if (!existing) {
      throw new NotFoundException('Transaction not found');
    }
    if (existing.status === TransactionStatus.SUCCESS || existing.status === TransactionStatus.FAILED) {
      if (existing.status === body.status) {
        return presentTransaction(existing);
      }
      throw new ConflictException('Transaction is already finalized');
    }

    const { fee, net } = splitFee(existing.amount);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.transactions.updateMany({
        where: { id: existing.id, status: TransactionStatus.PENDING },
        data: {
          status: body.status,
          fee: body.status === 'SUCCESS' ? fee : 0n,
          netAmount: body.status === 'SUCCESS' ? net : 0n,
        },
      });
      if (updated.count === 0) {
        const current = await tx.transactions.findUnique({ where: { id: existing.id } });
        return current?.status === body.status ? 'replay' : 'conflict';
      }

      await tx.payments.update({
        where: { id: existing.paymentId },
        data: { status: body.status === 'SUCCESS' ? PaymentStatus.SUCCESS : PaymentStatus.FAILED },
      });

      if (body.status === 'SUCCESS') {
        await this.credit(tx, {
          merchantId: existing.payment.merchantId,
          currency: existing.currency,
          referenceId: existing.publicId,
          fee,
          net,
        });
      }
      return 'applied';
    }, { maxWait: 10000, timeout: 20000 });

    if (outcome === 'conflict') {
      throw new ConflictException('Transaction is already finalized');
    }

    const fresh = await this.prisma.transactions.findUniqueOrThrow({
      where: { id: existing.id },
      include: transactionInclude,
    });
    return presentTransaction(fresh);
  }

  async refund(paymentId: string, actorId: string, paymentPublicId: string) {
    const payment = await this.prisma.payments.findUnique({
      where: { id: paymentId },
      include: { transactions: true },
    });
    if (!payment || payment.status !== PaymentStatus.SUCCESS) {
      throw new ConflictException('Payment is not refundable');
    }
    const transaction = payment.transactions.find((row) => row.status === TransactionStatus.SUCCESS);
    if (!transaction) {
      throw new ConflictException('Payment is not refundable');
    }

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.payments.updateMany({
        where: { id: payment.id, status: PaymentStatus.SUCCESS },
        data: { status: PaymentStatus.REFUNDED },
      });
      if (changed.count === 0) {
        throw new ConflictException('Payment is already refunded');
      }

      await this.debit(tx, {
        merchantId: payment.merchantId,
        currency: transaction.currency,
        referenceId: transaction.publicId,
        fee: transaction.fee,
        net: transaction.netAmount,
      });

      await tx.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          action: 'REFUND',
          subjectType: 'PAYMENT',
          subjectPublicId: paymentPublicId,
        },
      });
    }, { maxWait: 10000, timeout: 20000 });
  }

  private async credit(
    tx: Prisma.TransactionClient,
    input: { merchantId: string; currency: string; referenceId: string; fee: bigint; net: bigint },
  ) {
    await this.applyBalance(tx, input.merchantId, input.currency, input.net, 'increment');
    await this.applyPlatform(tx, input.currency, input.fee, 'increment');
    await tx.ledgers.create({
      data: {
        publicId: generatePublicId('pf-ledger'),
        account: LedgerAccount.MERCHANT,
        accountKey: input.merchantId,
        merchantId: input.merchantId,
        currency: input.currency,
        amount: input.net,
        type: LedgerType.CREDIT,
        referenceId: input.referenceId,
      },
    });
    await tx.ledgers.create({
      data: {
        publicId: generatePublicId('pf-ledger'),
        account: LedgerAccount.PLATFORM,
        accountKey: 'PLATFORM',
        currency: input.currency,
        amount: input.fee,
        type: LedgerType.CREDIT,
        referenceId: input.referenceId,
      },
    });
  }

  private async debit(
    tx: Prisma.TransactionClient,
    input: { merchantId: string; currency: string; referenceId: string; fee: bigint; net: bigint },
  ) {
    await this.applyBalance(tx, input.merchantId, input.currency, input.net, 'decrement');
    await this.applyPlatform(tx, input.currency, input.fee, 'decrement');
    await tx.ledgers.create({
      data: {
        publicId: generatePublicId('pf-ledger'),
        account: LedgerAccount.MERCHANT,
        accountKey: input.merchantId,
        merchantId: input.merchantId,
        currency: input.currency,
        amount: input.net,
        type: LedgerType.DEBIT,
        referenceId: input.referenceId,
      },
    });
    await tx.ledgers.create({
      data: {
        publicId: generatePublicId('pf-ledger'),
        account: LedgerAccount.PLATFORM,
        accountKey: 'PLATFORM',
        currency: input.currency,
        amount: input.fee,
        type: LedgerType.DEBIT,
        referenceId: input.referenceId,
      },
    });
  }

  private async applyBalance(
    tx: Prisma.TransactionClient,
    merchantId: string,
    currency: string,
    amount: bigint,
    direction: 'increment' | 'decrement',
  ) {
    await tx.merchantBalance.upsert({
      where: { merchantId_currency: { merchantId, currency } },
      create: { merchantId, currency, balance: 0n },
      update: {},
    });
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
        throw new ConflictException('Merchant balance is below the refund amount');
      }
    }
    await tx.merchantBalance.update({
      where: { merchantId_currency: { merchantId, currency } },
      data: { balance: { [direction]: amount } },
    });
  }

  private async applyPlatform(
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
        throw new ConflictException('Platform balance is below the refund amount');
      }
    }
    await tx.platformAccount.update({
      where: { currency },
      data: { balance: { [direction]: amount } },
    });
  }
}
