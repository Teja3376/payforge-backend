import { createHash } from 'crypto';
import { CardBrand, PaymentMethod, WalletProvider } from '@prisma/client';

export type SafeMethodDetails = {
  holderName?: string;
  brand?: CardBrand;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  vpa?: string;
  bankCode?: string;
  provider?: WalletProvider;
};

export function payloadHash(value: {
  paymentPublicId: string;
  method: PaymentMethod;
  details: SafeMethodDetails;
}): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
