import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser, IdempotencyKey } from '../../common/decorators/current-user.decorator';
import { Authenticated, Roles } from '../../common/decorators/roles.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { Scope } from '../../common/scopes/scopes';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { toMinor } from '../../common/money/money';
import { assertPublicId } from '../payments/payment.controller';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundResponseDto } from './dto/refund-response.dto';
import { RefundService } from './refund.service';
import { PrismaService } from '../../database/prisma.service';

@ApiTags('Refunds')
@Controller('refunds')
export class RefundController {
  constructor(
    private readonly refunds: RefundService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.REFUNDS_WRITE)
  @Authenticated()
  @ApiOperation({
    summary: 'Refund a payment, fully or partially',
    description:
      'Omit `amount` to refund everything remaining. Requires an Idempotency-Key header. Returns 200 when the key is replayed.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: RefundResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'Refund exceeds the remaining refundable amount.' })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'Insufficient merchant balance.' })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRefundDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    let amountMinor: bigint | undefined;
    if (dto.amount !== undefined) {
      const payment = await this.prisma.payments.findUnique({
        where: { publicId: dto.paymentId },
        select: { settlementCurrency: true },
      });
      amountMinor = toMinor(dto.amount, payment?.settlementCurrency ?? 'INR');
    }

    return this.refunds.create({
      user,
      paymentId: dto.paymentId,
      amountMinor,
      reason: dto.reason,
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Get()
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.REFUNDS_READ)
  @Authenticated()
  @ApiOperation({ summary: 'List refunds' })
  @ApiOkResponse({ type: RefundResponseDto, isArray: true })
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: PaginationQueryDto,
    @Query('paymentId') paymentId?: string,
  ) {
    return this.refunds.list(user, {
      limit: query.limit,
      cursor: query.cursor,
      paymentPublicId: paymentId,
    });
  }

  @Get(':publicId')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.REFUNDS_READ)
  @Authenticated()
  @ApiOperation({ summary: 'Get one refund' })
  @ApiParam({ name: 'publicId', example: 'PF-REF-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.refunds.get(user, assertPublicId(publicId));
  }
}