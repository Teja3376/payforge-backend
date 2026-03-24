import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { CreateMerchantDto } from './dto/create-merchant.dto'
import { generatePublicId } from '../../common/utils/generate-public-id'

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

    return {
      status: true,
      message: 'Merchant created successfully',
      data: merchant,
    }
  }

  async getAllMerchants() {

    const merchants = await this.prisma.merchants.findMany()

    return {
      status: true,
      message: 'Merchants fetched successfully',
      data: merchants,
    }
  }

  async getMerchant(publicId: string) {

    const merchant = await this.prisma.merchants.findUnique({
      where: { publicId },
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
      data: merchant,
    }
  }

}