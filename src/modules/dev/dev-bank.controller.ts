import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { TransactionResponseDto } from '../transactions/dto/transaction-response.dto';
import { signWebhook } from '../bank/webhook-signature';
import { WebhookDto } from '../webhooks/dto/webhook.dto';
import { WebhookService } from '../webhooks/webhook.service';

@ApiTags('Dev')
@Controller('dev')
export class DevBankController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @HttpCode(200)
  @Post('bank/settle')
  @ApiOperation({
    summary: 'Settle a mock bank charge',
    description: 'Available only when NODE_ENV is not production. Signs the body with the mock bank secret and runs the same settlement as the bank webhook.',
  })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  settle(@Body() dto: WebhookDto) {
    const signature = signWebhook(dto, this.config.getOrThrow<string>('MOCK_BANK_SECRET'));
    return this.webhooks.handle(dto, signature);
  }
}
