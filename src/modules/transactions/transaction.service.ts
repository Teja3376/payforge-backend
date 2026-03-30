import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "src/database/prisma.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { LedgerType, PaymentStatus, TransactionStatus, Transactions } from "@prisma/client";
import { generatePublicId } from "src/common/utils/generate-public-id";
import { toRupees } from "src/common/utils/format.money";
import { logger } from "src/common/logger/logger";

@Injectable()
export class TransactionService {
    constructor(private readonly prisma: PrismaService) { }

    async createTransaction(dto: CreateTransactionDto) {

        logger.info(`Create transaction request for payment ${dto.paymentPublicId} with method ${dto.method}`);
        const existingTransaction = await this.prisma.transactions.findUnique({
            where: { idempotencyKey: dto.idempotencyKey },
        });

        // Idempotency hit
        if (existingTransaction) {
            logger.info(`Idempotency hit for idempotency key ${dto.idempotencyKey}`);

            return {
                status: true,
                message: 'Transaction already exists',
                data: {
                    publicId: existingTransaction.publicId,
                    paymentId: dto.paymentPublicId,
                    method: existingTransaction.method,
                    amount: toRupees(existingTransaction.amount),
                    status: existingTransaction.status,
                    gatewayRef: existingTransaction.gatewayRef,
                    createdAt: existingTransaction.createdAt,
                }
            };
        }

        const payment = await this.prisma.payments.findUnique({
            where: { publicId: dto.paymentPublicId },
        });

        // Error log
        if (!payment) {
            logger.error(`Payment not found for public ID ${dto.paymentPublicId}`);

            throw new NotFoundException({
                status: false,
                message: 'Payment not found',
                data: {},
            });
        }

        if (payment.status === PaymentStatus.SUCCESS) {
            throw new BadRequestException('Payment already successful');
        }

        if (payment.status === PaymentStatus.FAILED) {
            throw new BadRequestException('Payment already failed');
        }

        const publicId = generatePublicId('pf-trx');

        const transaction: Transactions = await this.prisma.$transaction(async (tx) => {
            let created: Transactions;

            try {
                created = await tx.transactions.create({
                    data: {
                        publicId,
                        paymentId: payment.id,
                        method: dto.method,
                        status: TransactionStatus.PENDING,
                        gatewayRef: generatePublicId('pf-gw'),
                        amount: payment.amount,
                        idempotencyKey: dto.idempotencyKey,
                    },
                });
            } catch (error: any) {
                if (error.code === 'P2002') {
                    // Race condition log
                    logger.warn(`Duplicate idempotency key ${dto.idempotencyKey}`);

                    const existing = await tx.transactions.findUnique({
                        where: { idempotencyKey: dto.idempotencyKey },
                    });

                    return existing!;
                }

                throw error;
            }

            await tx.payments.update({
                where: { id: payment.id },
                data: { status: PaymentStatus.PENDING },
            });

            return created;
        });

        // Final success log
        logger.info(`Transaction created with public ID ${transaction.publicId}`);

        return {
            status: true,
            message: 'Transaction created successfully',
            data: {
                publicId: transaction.publicId,
                paymentId: payment.publicId,
                method: transaction.method,
                amount: toRupees(transaction.amount),
                status: transaction.status,
                gatewayRef: transaction.gatewayRef,
                createdAt: transaction.createdAt,
            }
        };
    }

    async updateTransaction(publicId: string, status: TransactionStatus) {
        logger.info(`Updating transaction with public ID ${publicId} to status ${status}`);
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
            logger.error(`Transaction not found for public ID ${publicId}`);
            throw new NotFoundException({
                status: false,
                message: 'Transaction not found',
                data: {},
            })
        }

        // Preventing the transaction status from being updated if it is already successful or failed
        if (transaction.status === TransactionStatus.SUCCESS || transaction.status === TransactionStatus.FAILED) {
            logger.error(`Transaction is already finalized for public ID ${publicId}`);
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

        logger.info(`Updating transaction status to ${status} for payment ${transaction.payment.publicId}`);
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

            // Add this block
            if (status === TransactionStatus.SUCCESS) {

                const payment = await tx.payments.findUnique({
                    where: { id: transaction.paymentId },
                    select: { merchantId: true, amount: true },
                });

                const amount = payment!.amount;

                // Fee logic
                const fee = Math.floor(Number(amount) * 0.02); // 2%
                const netAmount = Number(amount) - fee;

                // Save fee + net in transaction
                await tx.transactions.update({
                    where: { id: transaction.id },
                    data: {
                        fee,
                        netAmount,
                    },
                });

                // Ledger (ONLY NET)
                await tx.ledgers.create({
                    data: {
                        publicId: generatePublicId('pf-ledger'),
                        merchantId: payment!.merchantId,
                        amount: netAmount,
                        type: LedgerType.CREDIT,
                        referenceId: transaction.publicId,
                    }
                });

                // Balance (ONLY NET)
                await tx.merchants.update({
                    where: { id: payment!.merchantId },
                    data: {
                        balance: {
                            increment: netAmount,
                        },
                    },
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
            logger.error(`Transaction not found for public ID ${publicId}`);
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
    async getAllTransactions(cursor?: string, limit = 10) {

        const transactions = await this.prisma.transactions.findMany({
            take: limit,
            skip: cursor ? 1 : 0,
            cursor: cursor ? { publicId: cursor } : undefined,
            orderBy: {
                createdAt: "desc",
            },
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
            },
        });

        const nextCursor =
            transactions.length > 0
                ? transactions[transactions.length - 1].publicId
                : null;

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
            nextCursor,
        };
    }

}