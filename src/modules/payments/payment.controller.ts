import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser, IdempotencyKey } from '../../common/decorators/current-user.decorator';
import { Authenticated, Roles } from '../../common/decorators/roles.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { Scope } from '../../common/scopes/scopes';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { isPublicId } from '../../common/utils/generate-public-id';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { ClientSessionService } from './client-session.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CancelPaymentDto } from './dto/cancel-payment.dto';
import { PaymentResponseDto, PaymentListResponseDto } from './dto/payment-response.dto';
import { CreateClientSessionDto, ClientSessionResponseDto, SavePaymentMethodDto, SavedPaymentMethodResponseDto } from './dto/client-session.dto';
import { PaymentService } from './payment.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly clientSessions: ClientSessionService,
  ) {}

  @Post()
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYMENTS_WRITE)
  @ApiOperation({
    summary: 'Create a payment',
    description:
      'Freezes the FX quote and reserves the amount. Requires an `Idempotency-Key` header. ' +
      'Returns 200 on replay of a previously accepted key. ' +
      '\n\nA merchant may create a payment on behalf of a customer — this is the ' +
      'payment-intent flow: the merchant\'s server creates it, then hands the ' +
      'customer a client session to tokenise their card.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: PaymentResponseDto, description: 'A new payment.' })
  @ApiOkResponse({ type: PaymentResponseDto, description: 'Replay of an existing payment.' })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiForbiddenResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePaymentDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.payments.createPayment({ user, dto, idempotencyKey: idempotencyKey ?? '' });
    response.status(result.replayed ? 200 : 201);
    return result.payment;
  }

  @Get()
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({
    summary: 'List payments visible to you',
    description: 'Cursor-paginated. Pass `nextCursor` back as `cursor` for the next page.',
  })
  @ApiOkResponse({ type: PaymentListResponseDto })
  list(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.payments.listPayments(user, {
      limit: query.limit,
      cursor: query.cursor,
      order: query.order,
    });
  }


  @Post(':publicId/cancel')
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({
    summary: 'Cancel an unpaid payment',
    description: 'Only a payment in CREATED or PENDING can be cancelled. Settled payments must be refunded.',
  })
  @ApiParam({ name: 'publicId', example: 'PF-PAY-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  cancel(
    @CurrentUser() user: RequestUser,
    @Param('publicId') publicId: string,
    @Body() dto: CancelPaymentDto,
  ) {
    return this.payments.cancelPayment(user, assertPublicId(publicId), dto.reason);
  }

  /**
   * Mint a hosted-fields client secret.
   *
   * Call this from your server, then hand `clientSecret` to `@payforge/react`.
   * The card is captured inside the provider's iframe and never reaches
   * PayForge, which keeps you out of full PCI DSS scope.
   */
  @Post('client-session')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYMENTS_WRITE)
  @ApiOperation({
    summary: 'Create a hosted-fields client session',
    description:
      'Returns a short-lived client secret for the card iframe. Requires an API key with the payments:write scope.',
  })
  @ApiCreatedResponse({ type: ClientSessionResponseDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'API key is missing the required scope.' })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  clientSession(@CurrentUser() user: RequestUser, @Body() dto: CreateClientSessionDto) {
    return this.clientSessions.create(user.merchantId!, dto.paymentId);
  }

  @Post('payment-methods')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYMENTS_WRITE)
  @ApiOperation({
    summary: 'Save a tokenized card for future charges',
    description: 'Stores only the provider token plus brand and last 4 digits.',
  })
  @ApiCreatedResponse({ type: SavedPaymentMethodResponseDto })
  async saveMethod(@CurrentUser() user: RequestUser, @Body() dto: SavePaymentMethodDto) {
    return this.clientSessions.savePaymentMethod({
      merchantId: user.merchantId!,
      gatewayToken: dto.gatewayToken,
      customerRef: dto.customerRef,
      brand: dto.brand,
      last4: dto.last4,
      expiryMonth: dto.expiryMonth,
      expiryYear: dto.expiryYear,
      holderName: dto.holderName,
    });
  }

  @Get('payment-methods')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYMENTS_READ)
  @ApiOperation({ summary: 'List saved payment methods' })
  @ApiOkResponse({ type: SavedPaymentMethodResponseDto, isArray: true })
  listMethods(@CurrentUser() user: RequestUser, @Query('customerRef') customerRef?: string) {
    return this.clientSessions.listPaymentMethods(user.merchantId!, customerRef);
  }

  // Declared last on purpose.
  //
  // Express matches routes in declaration order, so `@Get(':publicId')` placed
  // above this swallowed the literal path: GET /payments/payment-methods hit
  // assertPublicId('payment-methods') and returned 400 "That id is not valid."
  // Compounding it, Scope.PAYMENTS_READ was enforced at exactly one route in
  // the whole codebase — this one — so the scope was offered to merchants,
  // grantable, and enforced nowhere reachable.
  @Get(':publicId')
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({ summary: 'Get one payment' })
  @ApiParam({ name: 'publicId', example: 'PF-PAY-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.payments.getPayment(user, assertPublicId(publicId));
  }
}

export function assertPublicId(value: string): string {
  if (!isPublicId(value)) {
    throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'That id is not valid.');
  }
  return value;
}