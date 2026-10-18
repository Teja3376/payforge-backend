import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RateLimit } from '../../common/config/rate-limits';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Authenticated, Roles } from '../../common/decorators/roles.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { Scope } from '../../common/scopes/scopes';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { Public } from '../../common/decorators/public.decorator';
import { assertPublicId } from '../payments/payment.controller';
import { BankWebhookDto } from './dto/webhook.dto';
import { EndpointResponseDto, DeliveryResponseDto, CreateEndpointDto, UpdateEndpointDto } from './dto/webhook-endpoint.dto';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookService } from './webhook.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly endpoints: WebhookEndpointService,
  ) {}

  /**
   * Inbound bank callback.
   *
   * Signature covers a timestamp and nonce, and callbacks older than five
   * minutes are rejected, so a captured request cannot be replayed later.
   */
  @Public()
  @Throttle({ bank: RateLimit.bank })
  @HttpCode(200)
  @Post('bank')
  @ApiOperation({
    summary: 'Bank settlement callback (inbound)',
    description:
      'Signed with HMAC-SHA256 over "{timestamp}.{nonce}.{gatewayRef}.{status}". Requests older than 5 minutes are rejected.',
  })
  @ApiHeader({
    name: 'x-payforge-signature',
    required: true,
    description: 'Hex HMAC-SHA256 of the canonical body using BANK_WEBHOOK_SECRET.',
  })
  @ApiOkResponse({ description: 'Settled, or replayed if already finalized.' })
  @ApiUnauthorizedResponse({ type: ApiErrorDto, description: 'Signature missing, invalid or expired.' })
  @ApiTooManyRequestsResponse({ type: ApiErrorDto, description: 'Too many callbacks from this IP.' })
  bank(@Body() dto: BankWebhookDto, @Headers('x-payforge-signature') signature?: string) {
    return this.webhooks.handle(
      {
        gatewayRef: dto.gatewayRef,
        status: dto.status,
        timestamp: dto.timestamp,
        nonce: dto.nonce,
        failureCode: dto.failureCode,
        failureMessage: dto.failureMessage,
      },
      signature,
    );
  }

  @Post('endpoints')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.WEBHOOKS_MANAGE)
  @Authenticated()
  @ApiOperation({
    summary: 'Register a webhook endpoint',
    description:
      'The signing secret is returned once. Verify deliveries with the helper exported by @payforge/node.',
  })
  @ApiCreatedResponse({ type: EndpointResponseDto })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateEndpointDto) {
    return this.endpoints.create(user.merchantId!, dto);
  }

  @Get('endpoints')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.WEBHOOKS_MANAGE)
  @Authenticated()
  @ApiOperation({ summary: 'List webhook endpoints' })
  @ApiOkResponse({ type: EndpointResponseDto, isArray: true })
  list(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.endpoints.list(user.merchantId!, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Patch('endpoints/:publicId')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.WEBHOOKS_MANAGE)
  @Authenticated()
  @ApiOperation({ summary: 'Update or disable a webhook endpoint' })
  @ApiParam({ name: 'publicId', example: 'PF-WH-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: EndpointResponseDto })
  update(
    @CurrentUser() user: RequestUser,
    @Param('publicId') publicId: string,
    @Body() dto: UpdateEndpointDto,
  ) {
    return this.endpoints.update(user.merchantId!, assertPublicId(publicId), dto);
  }

  @Post('endpoints/:publicId/rotate-secret')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.WEBHOOKS_MANAGE)
  @Authenticated()
  @ApiOperation({
    summary: 'Rotate the signing secret',
    description: 'Returns a new secret. Keep the old one working until you have deployed the replacement.',
  })
  @ApiOkResponse({ description: 'A new signing secret.' })
  rotate(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.endpoints.rotateSecret(user.merchantId!, assertPublicId(publicId));
  }

  @Get('endpoints/:publicId/deliveries')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.WEBHOOKS_MANAGE)
  @Authenticated()
  @ApiOperation({ summary: 'List delivery attempts for an endpoint' })
  @ApiParam({ name: 'publicId', example: 'PF-WH-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: DeliveryResponseDto, isArray: true })
  deliveries(
    @CurrentUser() user: RequestUser,
    @Param('publicId') publicId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.endpoints.deliveries(user.merchantId!, assertPublicId(publicId), {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Post('deliveries/:publicId/redeliver')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.WEBHOOKS_MANAGE)
  @Authenticated()
  @ApiOperation({ summary: 'Retry a failed or dead delivery' })
  @HttpCode(202)
  @ApiParam({ name: 'publicId', example: 'PF-DELIVERY-A1B2C3D4E5F6' })
  redeliver(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.endpoints.redeliver(user.merchantId!, assertPublicId(publicId));
  }
}