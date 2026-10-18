import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, WalletProvider } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { assertNotExpired } from '../card-validation';

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
    return 'Send only the details object that matches the payment method.';
  }
}

@ValidatorConstraint({ name: 'cardNotExpired', async: false })
class CardNotExpired implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const card = args.object as CardDetailsDto;
    if (!card.expiryMonth || !card.expiryYear) {
      return false;
    }
    try {
      // Evaluated against UTC by `assertNotExpired`, so the result does not
      // shift with the server's timezone.
      assertNotExpired(card.expiryMonth, card.expiryYear);
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage() {
    return 'That card has expired.';
  }
}

export class CardDetailsDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Enter the name on the card.' })
  @MaxLength(80, { message: 'Cardholder name must be 80 characters or fewer.' })
  holderName!: string;

  @ApiProperty({
    example: '4111111111111111',
    description:
      'Legacy direct-card path. Validated then discarded — only brand and last 4 are stored. Prefer the hosted-fields flow, which keeps the PAN off PayForge servers entirely.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @Matches(/^\d{12,19}$/, { message: 'Enter a card number with 12 to 19 digits.' })
  cardNumber!: string;

  @ApiProperty({ example: '123', description: 'Checked and never stored.' })
  @Matches(/^\d{3,4}$/, { message: 'Enter a 3 or 4 digit CVV.' })
  cvv!: string;

  @ApiProperty({ example: 12, minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt({ message: 'Expiry month must be a number from 1 to 12.' })
  @Min(1, { message: 'Expiry month must be a number from 1 to 12.' })
  @Max(12, { message: 'Expiry month must be a number from 1 to 12.' })
  expiryMonth!: number;

  @ApiProperty({ example: 2030 })
  @Type(() => Number)
  @IsInt({ message: 'Enter the card expiry year.' })
  @Min(new Date().getUTCFullYear(), {
    message: `Expiry year must be ${new Date().getUTCFullYear()} or later.`,
  })
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

  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.CARD,
    description:
      'How the payer is paying. When charging a saved method, use CARD together with `savedPaymentMethodId` and omit the inline `card` object.',
  })
  @IsEnum(PaymentMethod, {
    message: 'Choose a payment method: CARD, UPI, NET_BANKING, or WALLET.',
  })
  @Validate(MethodDetailsMatch)
  method!: PaymentMethod;

  @ApiPropertyOptional({ type: CardDetailsDto })
  @ValidateIf((dto: CreateTransactionDto) => dto.method === PaymentMethod.CARD && !dto.savedPaymentMethodId)
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

  @ApiPropertyOptional({
    example: 'PF-PM-XXXXXXXXXXXX',
    description: 'Charge a previously saved card instead of re-sending card data.',
  })
  @IsOptional()
  @IsString()
  savedPaymentMethodId?: string;

  @ApiPropertyOptional({
    example: 'tok_mock_6f1c0b2e3a4d4e5f',
    description:
      'Single-use token returned by the hosted-fields iframe. Charge it directly to take a one-off ' +
      'payment without first saving it. This is the PCI-safe path: the PAN never reaches PayForge.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'gatewayToken must be 255 characters or fewer.' })
  gatewayToken?: string;
}