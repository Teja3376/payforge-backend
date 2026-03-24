import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "src/database/prisma.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { PaymentStatus, TransactionStatus } from "@prisma/client";
import { generatePublicId } from "src/common/utils/generate-public-id";
import { toRupees } from "src/common/utils/format.money";

@Injectable()
export class TransactionService {
    constructor(private readonly prisma: PrismaService) { }

    async createTransaction(dto: CreateTransactionDto) {

        // check if payment exists
        const payment = await this.prisma.payments.findUnique({
            where: {
                publicId: dto.paymentPublicId,
            }
        })
        // if payment not found, throw an error
        if (!payment) {
            throw new NotFoundException({
                status: false,
                message: 'Payment not found',
                data: {},
            })
        }
        // if payment is already successful, throw an error
        if (payment.status === PaymentStatus.SUCCESS) {
            throw new BadRequestException({
                status: false,
                message: 'Payment is already successful',
                data: {},
            })
        }

        // if payment is already failed, throw an error
        if (payment.status === PaymentStatus.FAILED) {
            throw new BadRequestException({
                status: false,
                message: 'Payment is already failed',
                data: {},
            })
        }

        // create transaction
        const publicId = generatePublicId('pf-trx')
        const transaction = await this.prisma.$transaction(async (tx) => {
            const created = await tx.transactions.create({
                data: {
                    publicId,
                    paymentId: payment.id,
                    method: dto.method,
                    status: TransactionStatus.PENDING,
                    gatewayRef: generatePublicId('pf-gw'),
                },
            });

            await tx.payments.update({
                where: { id: payment.id },
                data: {
                    status: PaymentStatus.PENDING,
                },
            });

            return created;
        });

        // return transaction
        return {
            status: true,
            message: 'Transaction created successfully',
            data: {
                publicId: transaction.publicId,
                paymentId: payment.publicId,
                method: transaction.method,
                amount: toRupees(payment.amount),
                status: transaction.status,
                gatewayRef: transaction.gatewayRef,
                createdAt: transaction.createdAt,
            }
        }

    }

    async updateTransaction(publicId: string, status: TransactionStatus) {
        const transaction = await this.prisma.transactions.findUnique({
            where: { publicId },
            include: {
                payment: {
                    select: {
                        amount: true,
                        publicId: true,
                    },
                },
            },
        })
        if (!transaction) {
            throw new NotFoundException({
                status: false,
                message: 'Transaction not found',
                data: {},
            })
        }

        // Preventing the transaction status from being updated if it is already successful or failed
        if (transaction.status === TransactionStatus.SUCCESS || transaction.status === TransactionStatus.FAILED) {
            throw new BadRequestException({
                status: false,
                message: 'Transaction is already Finalized',
                data: {},
            })
        }

        let paymentStatus: PaymentStatus | null = null;
        if (status === TransactionStatus.SUCCESS) paymentStatus = PaymentStatus.SUCCESS;
        if (status === TransactionStatus.FAILED) paymentStatus = PaymentStatus.FAILED;
        if (status === TransactionStatus.PENDING) paymentStatus = PaymentStatus.PENDING;

        const updatedTransaction = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.transactions.update({
                where: { id: transaction.id },
                data: { status },
                include: {
                    payment: {
                        select: {
                            publicId: true,
                            amount: true,
                        },
                    },
                },
            });

            if (paymentStatus) {
                await tx.payments.update({
                    where: { id: transaction.paymentId },
                    data: { status: paymentStatus },
                });
            }

            return updated;
        });
        // return transaction
        return {
            status: true,
            message: 'Transaction updated successfully',
            data: {
                publicId: updatedTransaction.publicId,
                paymentId: updatedTransaction.payment.publicId,
                method: updatedTransaction.method,
                amount: toRupees(updatedTransaction.payment.amount),
                status: updatedTransaction.status,
                gatewayRef: updatedTransaction.gatewayRef,
                createdAt: updatedTransaction.createdAt,
            }
        }
    }

    async getTransaction(publicId: string) {
        const transaction = await this.prisma.transactions.findUnique({
            where: { publicId },
            include: {
                payment: {
                    select: {
                        publicId: true,
                        amount: true,
                    },
                },
            },
        })
        if (!transaction) {
            throw new NotFoundException({
                status: false,
                message: 'Transaction not found',
                data: {},
            })
        }
        return {
            status: true,
            message: 'Transaction found',
            data: {
                publicId: transaction.publicId,
                paymentId: transaction.payment.publicId,
                method: transaction.method,
                amount: toRupees(transaction.payment.amount),
                status: transaction.status,
                gatewayRef: transaction.gatewayRef,
                createdAt: transaction.createdAt,
            }
        }
    }
    async getAllTransactions() {
        const transactions = await this.prisma.transactions.findMany({
            select: {
                publicId: true,
                method: true,
                status: true,
                gatewayRef: true,
                createdAt: true,
                payment: {
                    select: {
                        publicId: true,
                        amount: true,
                    },
                },
            }
        })
        return {
            status: true,
            message: 'Transactions fetched successfully',
            data: transactions.map((t) => ({
                publicId: t.publicId,
                paymentId: t.payment.publicId,
                method: t.method,
                amount: toRupees(t.payment.amount),
                status: t.status,
                gatewayRef: t.gatewayRef,
                createdAt: t.createdAt,
            })),
        }
    }

}