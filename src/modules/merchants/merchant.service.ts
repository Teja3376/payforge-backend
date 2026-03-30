import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { CreateMerchantDto } from './dto/create-merchant.dto'
import { generatePublicId } from '../../common/utils/generate-public-id'
import { logger } from 'src/common/logger/logger'
import { toRupees } from 'src/common/utils/format.money'

@Injectable()
export class MerchantService {

  constructor(private readonly prisma: PrismaService) { }

  async createMerchant(dto: CreateMerchantDto) {

    const publicId = generatePublicId('pf-mer')

    const merchant = await this.prisma.merchants.create({
      data: {
        publicId,
        name: dto.name,
        email: dto.email,
      },
    })

    logger.info(`Merchant created with public ID ${publicId}`);
    return {
      status: true,
      message: 'Merchant created successfully',
      data: merchant,
    }
  }

  async getAllMerchants(cursor?: string, limit = 10) {

    const merchants = await this.prisma.merchants.findMany({
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { publicId: cursor } : undefined,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        publicId: true,
        name: true,
        email: true,
        balance: true,
        createdAt: true,
      },
    })

    const nextCursor = merchants.length > 0 ? merchants[merchants.length - 1].publicId : null;

    return {
      status: true,
      message: 'Merchants fetched successfully',
        data: merchants.map(m => ({
          publicId: m.publicId,
          name: m.name,
          email: m.email,
          balance: toRupees(m.balance),
          createdAt: m.createdAt,
        })),
      nextCursor,
    }
  }

  async getMerchant(publicId: string) {

    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
      select: {
        publicId: true,
        name: true,
        email: true,
        balance: true,
        createdAt: true,
      },
    })

    if (!merchant) {
      throw new NotFoundException({
        status: false,
        message: 'Merchant not found',
        data: null,
      })
    }

    return {
      status: true,
      message: 'Merchant fetched successfully',
      data: {
        publicId: merchant.publicId,
        name: merchant.name,
        email: merchant.email,
        balance: toRupees(merchant.balance),
        createdAt: merchant.createdAt,
      },
    }
  }

}