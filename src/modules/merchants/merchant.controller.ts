import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Authenticated, Roles } from '../../common/decorators/roles.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { Scope } from '../../common/scopes/scopes';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { assertPublicId } from '../payments/payment.controller';
import { UpdateMerchantDto, KycSubmissionDto, FeeScheduleDto } from './dto/merchant.dto';
import { MerchantResponseDto, StatementResponseDto } from './dto/merchant-response.dto';
import { MerchantService } from './merchant.service';

@ApiTags('Merchants')
@Controller('merchants')
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  @Get('me')
  @Roles(Role.MERCHANT)
  @Authenticated()
  @ApiOperation({
    summary: 'Get your merchant profile',
    description: 'Includes balances, settlement configuration, fee schedule and KYC state.',
  })
  @ApiOkResponse({ type: MerchantResponseDto })
  me(@CurrentUser() user: RequestUser) {
    return this.merchants.getMe(user);
  }

  @Patch('me')
  @Roles(Role.MERCHANT)
  @Scopes(Scope.MERCHANT_WRITE)
  @Authenticated()
  @ApiOperation({
    summary: 'Update your merchant profile',
    description: 'Settlement currency can only be changed by an administrator.',
  })
  @ApiOkResponse({ type: MerchantResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  async updateMe(@CurrentUser() user: RequestUser, @Body() dto: UpdateMerchantDto) {
    const merchant = await this.merchants.getMe(user);
    return this.merchants.update(user, merchant.publicId, dto);
  }

  @Post('me/kyc')
  @Roles(Role.MERCHANT)
  @Authenticated()
  @ApiOperation({
    summary: 'Submit KYC details',
    description: 'Moves the KYC state to SUBMITTED for administrator review.',
  })
  @ApiOkResponse({ type: MerchantResponseDto })
  async submitKyc(@CurrentUser() user: RequestUser, @Body() dto: KycSubmissionDto) {
    const merchant = await this.merchants.getMe(user);
    return this.merchants.submitKyc(user, merchant.publicId, dto);
  }

  @Post('me/fee-schedule')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({
    summary: 'Set your fee schedule',
    description: 'Applies to future payments. Existing payments keep the rate captured when they were created.',
  })
  @ApiOkResponse({ type: MerchantResponseDto })
  async setFees(@CurrentUser() user: RequestUser, @Body() dto: FeeScheduleDto) {
    const merchant = await this.merchants.getMe(user);
    return this.merchants.setFeeSchedule(user, merchant.publicId, dto.basisPoints);
  }

  @Get('me/statement')
  @Roles(Role.MERCHANT)
  @Scopes(Scope.MERCHANT_READ)
  @Authenticated()
  @ApiOperation({
    summary: 'Balance statement',
    description: 'Cursor-paginated entries from the append-only ledger, newest first.',
  })
  @ApiOkResponse({ type: StatementResponseDto })
  statement(
    @CurrentUser() user: RequestUser,
    @Query() query: PaginationQueryDto,
    @Query('currency') currency?: string,
  ) {
    return this.merchants.statement(user, {
      limit: query.limit,
      cursor: query.cursor,
      currency,
    });
  }

  @Get(':publicId')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({ summary: 'Get a merchant. A merchant can only open its own record.' })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: MerchantResponseDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.merchants.getMerchant(user, assertPublicId(publicId));
  }
}