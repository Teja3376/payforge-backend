import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser, IdempotencyKey } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { toMinor } from '../../common/money/money';
import { assertPublicId } from '../payments/payment.controller';
import { PrismaService } from '../../database/prisma.service';
import { AdminService } from './admin.service';
import { RefundRequestDto } from './dto/refund-request.dto';

@ApiTags('Admin')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto, description: 'Administrator access is required.' })
@Controller('admin')
@Roles(Role.SUPER_ADMIN)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Platform totals',
    description: 'Aggregated in the database. Merchant figures are reported separately, net of fees.',
  })
  @ApiOkResponse({ description: 'Platform fee totals and counts.' })
  overview() {
    return this.admin.overview();
  }

  @Get('merchants')
  @ApiOperation({
    summary: 'List merchants',
    description: 'Cursor-paginated. Includes merchants with no volume, unlike the fee summary.',
  })
  @ApiOkResponse({ description: 'A page of merchants.' })
  listMerchants(@Query() query: PaginationQueryDto, @Query('status') status?: string) {
    return this.admin.list({ limit: query.limit, cursor: query.cursor, order: query.order, status });
  }

  @Get('merchants/:publicId/revenue')
  @ApiOperation({
    summary: 'Per-merchant revenue, net of fees',
    description: 'Reads the ledger, so these figures reconcile with the merchant balance.',
  })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4E5F6' })
  @ApiOkResponse({ description: 'Net revenue by currency.' })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  revenue(@Param('publicId') publicId: string) {
    return this.admin.merchantRevenue(assertPublicId(publicId));
  }

  @Get('users')
  @ApiOperation({ summary: 'List users' })
  @ApiOkResponse({ description: 'A page of users.' })
  listUsers(@Query() query: PaginationQueryDto, @Query('status') status?: string) {
    return this.admin.listUsers({ limit: query.limit, cursor: query.cursor, status });
  }

  @Get('fees')
  @ApiOperation({
    summary: 'Ledger entries',
    description: 'Defaults to the PLATFORM account. Pass account=MERCHANT plus merchantId to inspect a merchant journal.',
  })
  @ApiOkResponse({ description: 'A page of ledger entries.' })
  fees(
    @Query() query: PaginationQueryDto,
    @Query('account') account?: 'MERCHANT' | 'PLATFORM',
    @Query('merchantId') merchantId?: string,
  ) {
    return this.admin.fees({ limit: query.limit, cursor: query.cursor, account, merchantId });
  }

  @Get('resolutions')
  @ApiOperation({
    summary: 'Audit trail',
    description: 'Every administrative action: suspensions, restorations, refunds, key rotations.',
  })
  @ApiOkResponse({ description: 'A page of audit entries.' })
  resolutions(
    @Query() query: PaginationQueryDto,
    @Query('subjectPublicId') subjectPublicId?: string,
    @Query('action') action?: string,
  ) {
    return this.admin.resolutions({ limit: query.limit, cursor: query.cursor, subjectPublicId, action });
  }

  @Post('merchants/:publicId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a pending merchant',
    description: 'Activates a merchant that self-registered so it can start receiving payments.',
  })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4E5F6' })
  @ApiOkResponse({ description: 'The updated status.' })
  @ApiConflictResponse({ type: ApiErrorDto })
  approve(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.approveMerchant(user.id, assertPublicId(publicId));
  }

  @Post('merchants/:publicId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a merchant' })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4E5F6' })
  @ApiOkResponse({ description: 'The updated status.' })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  suspendMerchant(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.suspendMerchant(user.id, assertPublicId(publicId));
  }

  @Post('merchants/:publicId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore a suspended merchant' })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4E5F6' })
  @ApiOkResponse({ description: 'The updated status.' })
  restoreMerchant(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.restoreMerchant(user.id, assertPublicId(publicId));
  }

  @Post('users/:publicId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a user' })
  @ApiParam({ name: 'publicId', example: 'PF-USR-D6DC83B1A2B3' })
  @ApiOkResponse({ description: 'The updated status.' })
  suspendUser(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.suspendUser(user.id, assertPublicId(publicId));
  }

  @Post('users/:publicId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore a suspended user' })
  @ApiParam({ name: 'publicId', example: 'PF-USR-D6DC83B1A2B3' })
  @ApiOkResponse({ description: 'The updated status.' })
  restoreUser(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.restoreUser(user.id, assertPublicId(publicId));
  }

  @Post('payments/:publicId/refund')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Refund a settled payment',
    description: 'Omit `amount` for a full refund. Requires an Idempotency-Key header.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiParam({ name: 'publicId', example: 'PF-PAY-A1B2C3D4E5F6' })
  @ApiOkResponse({ description: 'The refund record.' })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  async refund(
    @CurrentUser() user: RequestUser,
    @Param('publicId') publicId: string,
    @Body() dto: RefundRequestDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    const payment = await this.prisma.payments.findUnique({
      where: { publicId: assertPublicId(publicId) },
      select: { settlementCurrency: true },
    });

    return this.admin.refund({
      actorId: user.id,
      actorType: user.actorType,
      paymentPublicId: publicId,
      amountMinor: dto.amount === undefined ? undefined : toMinor(dto.amount, payment?.settlementCurrency ?? 'INR'),
      currency: payment?.settlementCurrency ?? 'INR',
      reason: dto.reason,
      idempotencyKey: idempotencyKey ?? '',
    });
  }
}