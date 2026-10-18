import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { toMajorNumber } from '../../common/money/money';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { quoteSettlement } from '../fx/fx-math';
import { FxService } from '../fx/fx.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

const paymentSelect = {
  publicId: true,
  amount: true,
  currency: true,
  fxRateDate: true,
  usdRate: true,
  inrRate: true,
  settlementAmount: true,
  settlementCurrency: true,
  status: true,
  createdAt: true,
  userId: true,
  merchantId: true,
  merchant: { select: { publicId: true, name: true } },
  user: { select: { publicId: true } },
} satisfies Prisma.PaymentsSelect;

type PaymentRow = Prisma.PaymentsGetPayload<{ select: typeof paymentSelect }>;

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  async createPayment(user: RequestUser, dto: CreatePaymentDto) {
    if (user.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Suspended users cannot pay');
    }

    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId: dto.merchantPublicId },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    if (merchant.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Merchant cannot receive payments');
    }

    const snapshot = await this.fx.ratesForToday();
    const quote = quoteSettlement({
      majorAmount: dto.amount,
      currency: dto.currency,
      countryCode: user.countryCode,
      rates: snapshot.rates,
    });

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
        status: PaymentStatus.CREATED,
      },
      select: paymentSelect,
    });

    return this.present(payment);
  }

  async getPayment(user: RequestUser, publicId: string) {
    const payment = await this.prisma.payments.findUnique({
      where: { publicId },
      select: paymentSelect,
    });
    if (!payment || !this.canSee(user, payment)) {
      throw new NotFoundException('Payment not found');
    }
    return this.present(payment);
  }

  async listPayments(user: RequestUser) {
    const where = this.scope(user);
    const payments = await this.prisma.payments.findMany({
      where,
      select: paymentSelect,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return payments.map((payment) => this.present(payment));
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
      status: payment.status,
      createdAt: payment.createdAt,
    };
  }
}
