import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { KeyMode, ProviderOnboarding } from '@prisma/client';

export class ReviewKycDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'], example: 'APPROVE' })
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({
    example: 'Registration documents could not be verified',
    description: 'Required when rejecting. Shown to the merchant.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    example: 'Checked against the registry extract dated 2026-10-01.',
    description: 'Admin-facing review notes. Not returned to the merchant.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNotes?: string;
}

export class SetMerchantModeDto {
  @ApiProperty({ enum: KeyMode, example: KeyMode.LIVE })
  @IsIn(['TEST', 'LIVE'])
  mode!: KeyMode;
}

export class SetMerchantRiskDto {
  @ApiPropertyOptional({ example: 12, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  riskScore?: number;

  @ApiPropertyOptional({ example: true, description: 'Screened against sanctions lists.' })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  sanctionsChecked?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Screened against PEP lists.' })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  pepChecked?: boolean;

  @ApiPropertyOptional({ example: 0.02, description: 'Rolling chargeback rate as a fraction.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  chargebackRate?: number;
}

export class SetProviderAccountDto {
  @ApiProperty({ example: 'stripe', description: 'Must match the wired BankPort implementation.' })
  @IsString()
  @MaxLength(32)
  provider!: string;

  @ApiPropertyOptional({ example: 'acct_1AbCdEfGhIjKlMnO' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerAccountId?: string;

  @ApiProperty({ enum: ProviderOnboarding, example: ProviderOnboarding.ENABLED })
  @IsIn(['NOT_STARTED', 'PENDING', 'RESTRICTED', 'ENABLED', 'DISABLED'])
  onboardingStatus!: ProviderOnboarding;

  @ApiProperty({ example: true, description: 'The provider will capture funds for this merchant.' })
  @IsBoolean()
  @Type(() => Boolean)
  chargesEnabled!: boolean;

  @ApiProperty({ example: true, description: 'The provider will send payouts to this merchant.' })
  @IsBoolean()
  @Type(() => Boolean)
  payoutsEnabled!: boolean;

  @ApiPropertyOptional({ example: 'Business verification incomplete' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  requirementsDue?: string;
}