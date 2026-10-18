import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
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
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { assertPublicId } from '../payments/payment.controller';
import { CreateDestinationDto, CreatePayoutDto } from './dto/create-payout.dto';
import { DestinationResponseDto, PayoutResponseDto } from './dto/payout-response.dto';
import { PayoutService } from './payout.service';
import { PrismaService } from '../../database/prisma.service';
import { encryptSecret } from '../../common/crypto/crypto';
import { generatePublicId } from '../../common/utils/generate-public-id';

@ApiTags('Payouts')
@Controller('payouts')
export class PayoutController {
  constructor(
    private readonly payouts: PayoutService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYOUTS_WRITE)
  @Authenticated()
  @ApiOperation({
    summary: 'Request a payout',
    description:
      'Debits your available balance immediately and schedules the transfer. Requires an Idempotency-Key header.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: PayoutResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'Insufficient available balance.' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePayoutDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    const currency = dto.currency.toUpperCase();
    let destinationId = dto.destinationId;

    if (!destinationId) {
      const fallback = await this.prisma.payoutDestination.findFirst({
        where: { merchantId: user.merchantId!, isDefault: true, status: 'ACTIVE' },
        select: { publicId: true },
      });
      if (!fallback) {
        throw ApiError.of(
          ErrorCode.VALIDATION_FAILED,
          'Add a payout destination before requesting a payout.',
        );
      }
      destinationId = fallback.publicId;
    }

    return this.payouts.create({
      merchantId: user.merchantId!,
      amountMinor: toMinor(dto.amount, currency),
      currency,
      destinationId,
      idempotencyKey: idempotencyKey ?? '',
      requestedById: user.id,
      actorType: user.actorType,
    });
  }

  @Get()
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYOUTS_READ)
  @Authenticated()
  @ApiOperation({ summary: 'List payouts' })
  @ApiOkResponse({ type: PayoutResponseDto, isArray: true })
  list(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.payouts.list(user.merchantId!, {
      limit: query.limit,
      cursor: query.cursor,
      order: query.order,
    });
  }


  @Post('destinations')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYOUTS_WRITE)
  @Authenticated()
  @ApiOperation({
    summary: 'Add a payout destination',
    description: 'The account number is encrypted at rest and only the last 4 digits are ever returned.',
  })
  @ApiCreatedResponse({ type: DestinationResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  async addDestination(@CurrentUser() user: RequestUser, @Body() dto: CreateDestinationDto) {
    const key = process.env.ENCRYPTION_KEY!;

    if (dto.isDefault) {
      await this.prisma.payoutDestination.updateMany({
        where: { merchantId: user.merchantId!, isDefault: true },
        data: { isDefault: false },
      });
    }

    const destination = await this.prisma.payoutDestination.create({
      data: {
        publicId: generatePublicId('pf-pd'),
        merchantId: user.merchantId!,
        bankName: dto.bankName,
        accountHolder: dto.accountHolder,
        accountLast4: dto.accountNumber.slice(-4),
        accountEnc: encryptSecret(dto.accountNumber, key),
        routingEnc: encryptSecret(dto.routingCode, key),
        currency: dto.currency.toUpperCase(),
        isDefault: dto.isDefault ?? false,
      },
    });

    return {
      publicId: destination.publicId,
      bankName: destination.bankName,
      accountHolder: destination.accountHolder,
      accountLast4: destination.accountLast4,
      currency: destination.currency,
      status: destination.status,
      isDefault: destination.isDefault,
      createdAt: destination.createdAt,
    };
  }

  // Declared before `@Get(':publicId')` on purpose.
  //
  // Express matches routes in declaration order, so the parameterised route
  // swallowed this literal path: GET /payouts/destinations hit
  // assertPublicId('destinations') and returned 400 "That id is not valid." A
  // merchant could add a payout bank account but never list it, and so never
  // learned the destinationId that POST /payouts requires.
  @Get('destinations')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYOUTS_READ)
  @Authenticated()
  @ApiOperation({ summary: 'List payout destinations' })
  @ApiOkResponse({ type: DestinationResponseDto, isArray: true })
  async listDestinations(@CurrentUser() user: RequestUser) {
    const rows = await this.prisma.payoutDestination.findMany({
      where: { merchantId: user.merchantId! },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      publicId: row.publicId,
      bankName: row.bankName,
      accountHolder: row.accountHolder,
      accountLast4: row.accountLast4,
      currency: row.currency,
      status: row.status,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
    }));
  }
  @Get(':publicId')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYOUTS_READ)
  @Authenticated()
  @ApiOperation({ summary: 'Get one payout' })
  @ApiParam({ name: 'publicId', example: 'PF-PO-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: PayoutResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.payouts.get(user.merchantId!, assertPublicId(publicId));
  }
}
