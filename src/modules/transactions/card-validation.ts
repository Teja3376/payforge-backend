import { BadRequestException } from '@nestjs/common';
import { CardBrand } from '@prisma/client';
import { CardValidator } from '@juspay/cards-validator';

const BRANDS: Record<string, CardBrand> = {
  visa: CardBrand.VISA,
  mastercard: CardBrand.MASTERCARD,
  amex: CardBrand.AMEX,
  rupay: CardBrand.RUPAY,
};

type CardResult = {
  card_brand?: string;
  card_type?: string;
  valid: boolean;
  cvv_length: number[];
};

export function validateCard(cardNumber: string, cvv: string): { brand: CardBrand; last4: string } {
  const details = new CardValidator(cardNumber).getCardDetails() as CardResult;
  if (!details.valid) {
    throw new BadRequestException('Card number is invalid');
  }

  const detected = details.card_brand ?? details.card_type;
  const brand = detected ? BRANDS[detected] : undefined;
  if (!brand) {
    throw new BadRequestException('Card network is not supported');
  }

  if (!details.cvv_length.includes(cvv.length)) {
    throw new BadRequestException('CVV length is invalid');
  }

  const digits = cardNumber.replace(/[\s-]/g, '');
  return { brand, last4: digits.slice(-4) };
}
