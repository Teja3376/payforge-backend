import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, KycStatus } from '@prisma/client';

export class MerchantBalanceDto {
  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 950.75, description: 'Available balance, in major units.' })
  amount!: number;

  @ApiProperty({ example: 0, description: 'Funds still inside the settlement delay window.' })
  pending!: number;
}

export class KycResponseDto {
  @ApiProperty({ enum: KycStatus, example: KycStatus.NOT_STARTED })
  status!: KycStatus;

  @ApiPropertyOptional({ example: 'Northwind Trading Ltd' })
  legalName?: string | null;

  @ApiPropertyOptional({ example: 'U24239MH2019PTC1234567' })
  registrationNumber?: string | null;

  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  taxId?: string | null;

  @ApiPropertyOptional({ example: 'IN' })
  countryCode?: string | null;

  @ApiPropertyOptional({ example: '12 MG Road' })
  addressLine1?: string | null;

  @ApiPropertyOptional({ example: 'Mumbai' })
  city?: string | null;

  @ApiPropertyOptional({ example: '2026-10-18T10:30:00.000Z' })
  submittedAt?: Date | null;

  @ApiPropertyOptional({ example: '2026-10-19T09:00:00.000Z' })
  reviewedAt?: Date | null;

  @ApiPropertyOptional({ example: 'Documents were illegible' })
  rejectionReason?: string | null;
}

export class FeeScheduleResponseDto {
  @ApiProperty({ example: 200 })
  basisPoints!: number;

  @ApiPropertyOptional({ example: 0 })
  minFee?: number | null;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  effectiveFrom!: Date;
}

export class MerchantResponseDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'Northwind Stores' })
  name!: string;

  @ApiProperty({ example: 'merchant@example.com' })
  email!: string;

  @ApiProperty({
    enum: AccountStatus,
    example: AccountStatus.ACTIVE,
    description: 'PENDING_REVIEW merchants cannot receive payments.',
  })
  status!: AccountStatus;

  @ApiProperty({
    enum: ['LIVE', 'TEST'],
    example: 'TEST',
    description: 'TEST merchants accept test card numbers and never move real money.',
  })
  mode!: 'LIVE' | 'TEST';

  @ApiProperty({ example: 'IN' })
  countryCode!: string;

  @ApiProperty({ example: 'INR' })
  settlementCurrency!: string;

  @ApiProperty({ example: 2, description: 'Days between settlement and availability.' })
  settlementDelayDays!: number;

  @ApiProperty({ example: 200 })
  feeBasisPoints!: number;

  @ApiPropertyOptional({ type: FeeScheduleResponseDto })
  feeSchedule?: FeeScheduleResponseDto | null;

  @ApiProperty({ type: KycResponseDto })
  kyc!: KycResponseDto;

  @ApiProperty({ type: [MerchantBalanceDto] })
  balances!: MerchantBalanceDto[];

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}

export class StatementEntryDto {
  @ApiProperty({ example: 'PF-LEDGER-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ enum: ['CREDIT', 'DEBIT'] })
  type!: string;

  @ApiProperty({ example: 931.73 })
  amount!: number;

  @ApiPropertyOptional({ example: 931.73, description: 'Running balance after this entry.' })
  balanceAfter?: number | null;

  @ApiProperty({ example: 'PF-TRX-A1B2C3D4E5F6' })
  referenceId!: string;

  @ApiProperty({ example: '2026-10-18T10:31:00.000Z' })
  createdAt!: Date;
}

export class StatementResponseDto {
  @ApiProperty({ type: [StatementEntryDto] })
  data!: StatementEntryDto[];

  @ApiProperty({ example: false })
  hasMore!: boolean;

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
