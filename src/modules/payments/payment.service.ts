import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "src/database/prisma.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { generatePublicId } from "src/common/utils/generate-public-id";
import { toPaisa, toRupees } from "src/common/utils/format.money";
import { PaymentStatus } from "@prisma/client";

@Injectable()
export class PaymentService {

    constructor(private readonly prisma: PrismaService) { }

    async createPayment(dto: CreatePaymentDto) {

        const publicId = generatePublicId('pf-pay')

        const merchant = await this.prisma.merchants.findUnique({
            where: { publicId: dto.merchantId },
        })

        if (!merchant) {
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
                amount,
                currency: dto.currency,
                status: PaymentStatus.CREATED,
                metadata: dto.metadata,
            },
        })

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

    async getAllPayments() {
        const payments = await this.prisma.payments.findMany({
            select: {
                publicId: true,
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
            ...p,
            amount: toRupees(p.amount),
        }))

        return {
            status: true,
            message: 'Payments fetched successfully',
            data: formatted,
        }
    }
}