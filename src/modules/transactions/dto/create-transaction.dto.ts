import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, WalletProvider } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const detailKeyByMethod = {
  [PaymentMethod.CARD]: 'card',
  [PaymentMethod.UPI]: 'upi',
  [PaymentMethod.NET_BANKING]: 'netBanking',
  [PaymentMethod.WALLET]: 'wallet',
} as const;

@ValidatorConstraint({ name: 'methodDetailsMatch', async: false })
class MethodDetailsMatch implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const dto = args.object as CreateTransactionDto;
    const provided = (Object.values(detailKeyByMethod) as Array<keyof CreateTransactionDto>).filter(
      (key) => dto[key] != null,
    );
    const expected = detailKeyByMethod[dto.method];
    return expected != null && provided.length === 1 && provided[0] === expected;
  }

  defaultMessage() {
    return 'Send only the details object that matches the payment method';
  }
}

@ValidatorConstraint({ name: 'cardNotExpired', async: false })
class CardNotExpired implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const card = args.object as CardDetailsDto;
    if (!card.expiryMonth || !card.expiryYear) {
      return false;
    }
    const endOfExpiryMonth = new Date(card.expiryYear, card.expiryMonth, 0, 23, 59, 59);
    return endOfExpiryMonth >= new Date();
  }

  defaultMessage() {
    return 'Card is expired';
  }
}

export class CardDetailsDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Enter the name on the card.' })
  @MaxLength(80, { message: 'Cardholder name must be 80 characters or fewer.' })
  holderName!: string;

  @ApiProperty({ example: '4111111111111111', description: 'Validated, then stored only as brand and last 4 digits.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @Matches(/^\d{12,19}$/, { message: 'Enter a card number with 12 to 19 digits.' })
  cardNumber!: string;

  @ApiProperty({ example: '123', description: 'Checked and never stored.' })
  @Matches(/^\d{3,4}$/, { message: 'Enter a 3 or 4 digit CVV.' })
  cvv!: string;

  @ApiProperty({ example: 12, minimum: 1, maximum: 12 })
  @IsInt({ message: 'Expiry month must be a number from 1 to 12.' })
  @Min(1, { message: 'Expiry month must be a number from 1 to 12.' })
  @Max(12, { message: 'Expiry month must be a number from 1 to 12.' })
  expiryMonth!: number;

  @ApiProperty({ example: 2030 })
  @IsInt({ message: 'Enter the card expiry year.' })
  @Min(2026, { message: 'Expiry year must be 2026 or later.' })
  @Max(2100, { message: 'Expiry year is too far in the future.' })
  @Validate(CardNotExpired)
  expiryYear!: number;
}

export class UpiDetailsDto {
  @ApiProperty({ example: 'ada@okaxis' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/, {
    message: 'Enter a valid UPI ID, such as name@bank.',
  })
  vpa!: string;
}

export class NetBankingDetailsDto {
  @ApiProperty({ example: 'HDFC' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9]{2,16}$/, { message: 'Enter a bank code with 2 to 16 letters or numbers.' })
  bankCode!: string;
}

export class WalletDetailsDto {
  @ApiProperty({ enum: WalletProvider, example: WalletProvider.PAYTM })
  @IsEnum(WalletProvider, {
    message: 'Choose a wallet: PAYTM, PHONEPE, AMAZON_PAY, or MOBIKWIK.',
  })
  provider!: WalletProvider;
}

export class CreateTransactionDto {
  @ApiProperty({ example: 'PF-PAY-A1B2C3D4' })
  @IsString()
  @IsNotEmpty({ message: 'Enter the payment id.' })
  paymentPublicId!: string;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CARD })
  @IsEnum(PaymentMethod, {
    message: 'Choose a payment method: CARD, UPI, NET_BANKING, or WALLET.',
  })
  @Validate(MethodDetailsMatch)
  method!: PaymentMethod;

  @ApiPropertyOptional({ type: CardDetailsDto })
  @ValidateIf((dto: CreateTransactionDto) => dto.method === PaymentMethod.CARD)
  @ValidateNested()
  @Type(() => CardDetailsDto)
  card?: CardDetailsDto;

  @ApiPropertyOptional({ type: UpiDetailsDto })
  @ValidateIf((dto: CreateTransactionDto) => dto.method === PaymentMethod.UPI)
  @ValidateNested()
  @Type(() => UpiDetailsDto)
  upi?: UpiDetailsDto;

  @ApiPropertyOptional({ type: NetBankingDetailsDto })
  @ValidateIf((dto: CreateTransactionDto) => dto.method === PaymentMethod.NET_BANKING)
  @ValidateNested()
  @Type(() => NetBankingDetailsDto)
  netBanking?: NetBankingDetailsDto;

  @ApiPropertyOptional({ type: WalletDetailsDto })
  @ValidateIf((dto: CreateTransactionDto) => dto.method === PaymentMethod.WALLET)
  @ValidateNested()
  @Type(() => WalletDetailsDto)
  wallet?: WalletDetailsDto;

  @ApiProperty({ example: 'order-1001', maxLength: 80 })
  @IsString()
  @MinLength(1, { message: 'Enter an idempotency key.' })
  @MaxLength(80, { message: 'Idempotency key must be 80 characters or fewer.' })
  idempotencyKey!: string;
}
