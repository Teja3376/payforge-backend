import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser, IdempotencyKey } from '../../common/decorators/current-user.decorator';
import { Authenticated, Roles } from '../../common/decorators/roles.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import { Scope } from '../../common/scopes/scopes';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { assertPublicId } from '../payments/payment.controller';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionResponseDto } from './dto/transaction-response.dto';
import { TransactionService } from './transaction.service';

@ApiTags('Transactions')
@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactions: TransactionService) {}

  @Post()
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.PAYMENTS_WRITE)
  @ApiOperation({
    summary: 'Pay a payment',
    description:
      'Returns 201 for a new attempt and 200 when the same Idempotency-Key and payload are replayed. ' +
      'Prefer charging a saved method over resending card data. ' +
      '\n\nA merchant API key may charge a payment it created, which is what makes the ' +
      'payment-intent flow usable end to end from a merchant server.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: TransactionResponseDto, description: 'A new pending transaction.' })
  @ApiOkResponse({ type: TransactionResponseDto, description: 'Replay of the original transaction.' })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'The payment already has an open transaction.' })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTransactionDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.transactions.createTransaction({
      user,
      dto,
      idempotencyKey: idempotencyKey ?? '',
    });
    response.status(result.replayed ? 200 : 201);
    return result.transaction;
  }

  @Get()
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({
    summary: 'List transactions visible to you',
    description: 'Cursor-paginated. Pass `nextCursor` back as `cursor` for the next page.',
  })
  @ApiOkResponse({ type: TransactionResponseDto, isArray: true })
  list(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.transactions.listTransactions(user, {
      limit: query.limit,
      cursor: query.cursor,
      order: query.order,
    });
  }

  @Get(':publicId')
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({ summary: 'Get one transaction' })
  @ApiParam({ name: 'publicId', example: 'PF-TRX-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.transactions.getTransaction(user, assertPublicId(publicId));
  }
}