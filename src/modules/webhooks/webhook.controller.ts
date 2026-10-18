import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { Public } from '../../common/decorators/public.decorator';
import { TransactionResponseDto } from '../transactions/dto/transaction-response.dto';
import { WebhookDto } from './dto/webhook.dto';
import { WebhookService } from './webhook.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Public()
  @HttpCode(200)
  @Post('bank')
  @ApiOperation({ summary: 'Settle a transaction from a signed bank callback' })
  @ApiHeader({
    name: 'x-payforge-signature',
    required: true,
    description: 'Hex HMAC-SHA256 of {"gatewayRef","status"} using the bank secret.',
  })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto, description: 'The signature does not match.' })
  bank(@Body() dto: WebhookDto, @Headers('x-payforge-signature') signature?: string) {
    return this.webhooks.handle(dto, signature);
  }
}
