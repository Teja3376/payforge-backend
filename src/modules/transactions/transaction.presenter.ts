import { CardBrand, PaymentMethod, Prisma, WalletProvider } from '@prisma/client';
import { toMajorNumber } from '../../common/money/money';

export const transactionInclude = {
  cardDetail: true,
  upiDetail: true,
  netBankingDetail: true,
  walletDetail: true,
  payment: { select: { publicId: true, userId: true, merchantId: true } },
} satisfies Prisma.TransactionsInclude;

export type TransactionWithDetails = Prisma.TransactionsGetPayload<{ include: typeof transactionInclude }>;

export function methodDetails(transaction: {
  method: PaymentMethod;
  cardDetail: {
    holderName: string;
    brand: CardBrand;
    last4: string;
    expiryMonth: number;
    expiryYear: number;
  } | null;
  upiDetail: { vpa: string } | null;
  netBankingDetail: { bankCode: string } | null;
  walletDetail: { provider: WalletProvider } | null;
}) {
  switch (transaction.method) {
    case PaymentMethod.CARD:
      return transaction.cardDetail
        ? {
            holderName: transaction.cardDetail.holderName,
            brand: transaction.cardDetail.brand,
            last4: transaction.cardDetail.last4,
            expiryMonth: transaction.cardDetail.expiryMonth,
            expiryYear: transaction.cardDetail.expiryYear,
          }
        : null;
    case PaymentMethod.UPI:
      return transaction.upiDetail ? { vpa: transaction.upiDetail.vpa } : null;
    case PaymentMethod.NET_BANKING:
      return transaction.netBankingDetail ? { bankCode: transaction.netBankingDetail.bankCode } : null;
    case PaymentMethod.WALLET:
      return transaction.walletDetail ? { provider: transaction.walletDetail.provider } : null;
  }
}

export function presentTransaction(transaction: TransactionWithDetails) {
  return {
    publicId: transaction.publicId,
    paymentId: transaction.payment.publicId,
    method: transaction.method,
    methodDetails: methodDetails(transaction),
    amount: toMajorNumber(transaction.amount, transaction.currency),
    currency: transaction.currency,
    fee: toMajorNumber(transaction.fee, transaction.currency),
    netAmount: toMajorNumber(transaction.netAmount, transaction.currency),
    status: transaction.status,
    gatewayRef: transaction.gatewayRef,
    createdAt: transaction.createdAt,
  };
}
