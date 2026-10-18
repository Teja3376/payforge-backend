import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountStatus, LedgerAccount, ResolutionAction, ResolutionSubject } from '@prisma/client';
import { toMajorNumber } from '../../common/money/money';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { SettlementService } from '../webhooks/settlement.service';
import { merchantMoney, platformFeeTotals } from './overview';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
  ) {}

  async overview() {
    const now = new Date();
    const [merchants, payments, entries] = await Promise.all([
      this.prisma.merchants.findMany({
        select: { id: true, publicId: true, name: true, createdAt: true },
      }),
      this.prisma.payments.findMany({
        where: { status: 'SUCCESS' },
        select: {
          merchantId: true,
          settlementAmount: true,
          settlementCurrency: true,
          createdAt: true,
        },
      }),
      this.prisma.ledgers.findMany({
        where: { account: LedgerAccount.PLATFORM },
        select: { currency: true, amount: true, type: true, createdAt: true },
      }),
    ]);

    const fees = platformFeeTotals(entries, now);
    const rows = merchantMoney(merchants, payments, now);
    return {
      platformFeeThisMonth: this.moneyMap(fees.thisMonth),
      platformFeeAllTime: this.moneyMap(fees.allTime),
      merchants: rows.map((merchant) => ({
        publicId: merchant.publicId,
        name: merchant.name,
        months: merchant.months,
        byCurrency: merchant.byCurrency.map((row) => ({
          currency: row.currency,
          thisMonth: toMajorNumber(row.thisMonthMinor, row.currency),
          averagePerMonth: toMajorNumber(row.averageMinor, row.currency),
        })),
      })),
    };
  }

  async fees() {
    const entries = await this.prisma.ledgers.findMany({
      where: { account: LedgerAccount.PLATFORM },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return entries.map((entry) => ({
      publicId: entry.publicId,
      currency: entry.currency,
      amount: toMajorNumber(entry.amount, entry.currency),
      type: entry.type,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt,
    }));
  }

  suspendMerchant(actorId: string, publicId: string) {
    return this.setMerchantStatus(actorId, publicId, AccountStatus.SUSPENDED, ResolutionAction.SUSPEND_MERCHANT);
  }

  restoreMerchant(actorId: string, publicId: string) {
    return this.setMerchantStatus(actorId, publicId, AccountStatus.ACTIVE, ResolutionAction.RESTORE_MERCHANT);
  }

  suspendUser(actorId: string, publicId: string) {
    return this.setUserStatus(actorId, publicId, AccountStatus.SUSPENDED, ResolutionAction.SUSPEND_USER);
  }

  restoreUser(actorId: string, publicId: string) {
    return this.setUserStatus(actorId, publicId, AccountStatus.ACTIVE, ResolutionAction.RESTORE_USER);
  }

  async refund(actorId: string, publicId: string) {
    const payment = await this.prisma.payments.findUnique({ where: { publicId } });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    await this.settlement.refund(payment.id, actorId, publicId);
    return { publicId, status: 'REFUNDED' };
  }

  private async setMerchantStatus(
    actorId: string,
    publicId: string,
    status: AccountStatus,
    action: ResolutionAction,
  ) {
    const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    if (merchant.status === status) {
      throw new ConflictException(`This merchant is already ${status === 'ACTIVE' ? 'active' : 'suspended'}.`);
    }
    await this.prisma.$transaction([
      this.prisma.merchants.update({ where: { id: merchant.id }, data: { status } }),
      this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          action,
          subjectType: ResolutionSubject.MERCHANT,
          subjectPublicId: publicId,
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
      throw new NotFoundException('User not found');
    }
    if (user.status === status) {
      throw new ConflictException(`This user is already ${status === 'ACTIVE' ? 'active' : 'suspended'}.`);
    }
    await this.prisma.$transaction([
      this.prisma.users.update({ where: { id: user.id }, data: { status } }),
      this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          action,
          subjectType: ResolutionSubject.USER,
          subjectPublicId: publicId,
        },
      }),
    ]);
    return { publicId, status };
  }

  private moneyMap(values: Map<string, bigint>) {
    return [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => ({
        currency,
        amount: toMajorNumber(amount, currency),
      }));
  }
}
