import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse, ApiBadRequestResponse } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { PaymentService } from './payment.service';

@ApiTags('Payments')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@Controller('payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post()
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Create a payment as the signed-in customer' })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreatePaymentDto) {
    return this.payments.createPayment(user, dto);
  }

  @Get()
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List payments visible to the signed-in role' })
  @ApiOkResponse({ type: PaymentResponseDto, isArray: true })
  list(@CurrentUser() user: RequestUser) {
    return this.payments.listPayments(user);
  }

  @Get(':publicId')
  @Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get one payment visible to the signed-in role' })
  @ApiParam({ name: 'publicId', example: 'PF-PAY-A1B2C3D4' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.payments.getPayment(user, publicId);
  }
}
