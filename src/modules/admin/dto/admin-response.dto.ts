import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, LedgerType } from '@prisma/client';

export class MoneyTotalDto {
  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 19.02 })
  amount!: number;
}

export class MerchantCurrencyAverageDto {
  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 950.75 })
  thisMonth!: number;

  @ApiProperty({ example: 950.75 })
  averagePerMonth!: number;
}

export class MerchantOverviewDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'Northwind Stores' })
  name!: string;

  @ApiProperty({ example: 1 })
  months!: number;

  @ApiProperty({ type: [MerchantCurrencyAverageDto] })
  byCurrency!: MerchantCurrencyAverageDto[];
}

export class AdminOverviewDto {
  @ApiProperty({ type: [MoneyTotalDto] })
  platformFeeThisMonth!: MoneyTotalDto[];

  @ApiProperty({ type: [MoneyTotalDto] })
  platformFeeAllTime!: MoneyTotalDto[];

  @ApiProperty({ type: [MerchantOverviewDto] })
  merchants!: MerchantOverviewDto[];
}

export class FeeEntryDto {
  @ApiProperty({ example: 'PF-LEDGER-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 19.02 })
  amount!: number;

  @ApiProperty({ enum: LedgerType, example: LedgerType.CREDIT })
  type!: LedgerType;

  @ApiProperty({ example: 'PF-TRX-A1B2C3D4' })
  referenceId!: string;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}

export class AccountActionDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ enum: AccountStatus, example: AccountStatus.SUSPENDED })
  status!: AccountStatus;
}

export class RefundResultDto {
  @ApiProperty({ example: 'PF-PAY-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'REFUNDED' })
  status!: 'REFUNDED';
}
