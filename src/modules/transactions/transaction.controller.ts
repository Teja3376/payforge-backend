import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse, ApiBadRequestResponse, ApiConflictResponse } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionResponseDto } from './dto/transaction-response.dto';
import { TransactionService } from './transaction.service';

@ApiTags('Transactions')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactions: TransactionService) {}

  @Post()
  @Roles(Role.USER)
  @ApiOperation({
    summary: 'Pay a payment with card, UPI, net banking, or wallet',
    description: 'Returns 201 for a new attempt and 200 when the same idempotency key and details are sent again.',
  })
  @ApiCreatedResponse({ type: TransactionResponseDto, description: 'A new pending transaction.' })
  @ApiOkResponse({ type: TransactionResponseDto, description: 'Replay of the original transaction.' })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.transactions.createTransaction(user, dto);
    response.status(result.replay ? 200 : 201);
    return result.body;
  }

  @Get()
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List transactions visible to the signed-in role' })
  @ApiOkResponse({ type: TransactionResponseDto, isArray: true })
  list(@CurrentUser() user: RequestUser) {
    return this.transactions.listTransactions(user);
  }

  @Get(':publicId')
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get one transaction visible to the signed-in role' })
  @ApiParam({ name: 'publicId', example: 'PF-TRX-A1B2C3D4' })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.transactions.getTransaction(user, publicId);
  }
}
