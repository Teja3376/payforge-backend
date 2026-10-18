import { Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { toMajorNumber } from '../../common/money/money';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class MerchantService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: RequestUser) {
    if (!user.merchantId) {
      throw new NotFoundException('Merchant not found');
    }
    const merchant = await this.prisma.merchants.findUnique({
      where: { id: user.merchantId },
      include: { balances: true },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    return this.present(merchant);
  }

  async getMerchant(user: RequestUser, publicId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      include: { balances: true },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    const ownsMerchant = user.role === Role.MERCHANT && merchant.id === user.merchantId;
    if (user.role !== Role.SUPER_ADMIN && !ownsMerchant) {
      throw new NotFoundException('Merchant not found');
    }
    return this.present(merchant);
  }

  private present(merchant: {
    publicId: string;
    name: string;
    email: string;
    status: string;
    createdAt: Date;
    balances: { currency: string; balance: bigint }[];
  }) {
    return {
      publicId: merchant.publicId,
      name: merchant.name,
      email: merchant.email,
      status: merchant.status,
      createdAt: merchant.createdAt,
      balances: merchant.balances
        .sort((left, right) => left.currency.localeCompare(right.currency))
        .map((balance) => ({
          currency: balance.currency,
          amount: toMajorNumber(balance.balance, balance.currency),
        })),
    };
  }
}
