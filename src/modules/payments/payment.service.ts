import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "src/database/prisma.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { generatePublicId } from "src/common/utils/generate-public-id";
import { toPaisa, toRupees } from "src/common/utils/format.money";
import { PaymentStatus } from "@prisma/client";
import { logger } from "src/common/logger/logger";

@Injectable()
export class PaymentService {

    constructor(private readonly prisma: PrismaService) { }

    async createPayment(dto: CreatePaymentDto) {

        const publicId = generatePublicId('pf-pay')

        const merchant = await this.prisma.merchants.findUnique({
            where: { publicId: dto.merchantId },
        })

        if (!merchant) {
            logger.error(`Merchant not found for public ID ${dto.merchantId}`);
            throw new NotFoundException({
                status: false,
                message: 'Merchant not found',
                data: null,
            })
        }

        const amount = toPaisa(dto.amount)

        const payment = await this.prisma.payments.create({
            data: {
                publicId,
                merchantId: merchant.id,
                payerName: dto.payerName,
                payerEmail: dto.payerEmail,
                countryCode: dto.countryCode,
                payerPhone: dto.payerPhone,
                amount,
                currency: dto.currency,
                status: PaymentStatus.CREATED,
                metadata: dto.metadata,
            },
        })

        logger.info(`Payment created with public ID ${publicId}`);
        return {
            status: true,
            message: 'Payment created successfully',
            data: {
                ...payment,
                amount: toRupees(payment.amount),
            }
        }
    }

    async getPayment(publicId: string) {

        const payment = await this.prisma.payments.findUnique({
            where: { publicId },
            select: {
                publicId: true,
                payerName: true,
                payerEmail: true,
                countryCode: true,
                payerPhone: true,
                amount: true,
                merchant: {
                    select: {
                        publicId: true,
                        name: true,
                        email: true,
                    }
                },
                currency: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                transactions: {
                    select: {
                        publicId: true,
                        method: true,
                        status: true,
                    }
                }
            }
        })

        if (!payment) {
            throw new NotFoundException({
                status: false,
                message: 'Payment not found',
                data: null,
            })
        }

        return {
            status: true,
            message: 'Payment fetched successfully',
            data: {
                ...payment,
                amount: toRupees(payment.amount),
            }
        }
    }

    async getAllPayments(cursor?: string, limit = 2) {
        const payments = await this.prisma.payments.findMany({
            take: limit,
            skip: cursor ? 1 : 0,
            cursor: cursor ? { publicId: cursor } : undefined,
            orderBy: {
                createdAt: 'desc',
            },
            select: {
                publicId: true,
                payerName: true,
                payerEmail: true,
                countryCode: true,
                payerPhone: true,
                amount: true,
                merchant: {
                    select: {
                        publicId: true,
                        name: true,
                        email: true,
                    }
                },
                currency: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                transactions: {
                    select: {
                        publicId: true,
                        method: true,
                        status: true,
                    }
                }
            },
        })

        const formatted = payments.map((p) => ({
            publicId: p.publicId,
            amount: toRupees(p.amount),
            payerName: p.payerName,
            payerEmail: p.payerEmail,
            countryCode: p.countryCode,
            payerPhone: p.payerPhone,
            currency: p.currency,
            status: p.status,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            merchant: {
              publicId: p.merchant.publicId,
              name: p.merchant.name,
              email: p.merchant.email,
            },
            transactions: p.transactions.map((t) => ({
              publicId: t.publicId,
              method: t.method,
              status: t.status,
            })),
          }));

        const nextCursor = payments.length > 0 ? payments[payments.length - 1].publicId : null;

        return {
            status: true,
            message: 'Payments fetched successfully',
            data: formatted,
            nextCursor,
        }
    }
}