import { Body, Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { BankWebhookDto } from '../webhooks/dto/webhook.dto';
import { WebhookService } from '../webhooks/webhook.service';
import { signWebhook } from '../bank/webhook-signature';

/**
 * Development-only settlement helper.
 *
 * Two hard problems with the original implementation are fixed here:
 *
 * 1. **It was `@Public()`.** Anyone who could reach `POST /dev/bank/settle`
 *    could mark any transaction successful and credit a merchant balance. Every
 *    payer receives their own `gatewayRef` in the transaction response, so a
 *    customer could self-settle their own payment for free. It now requires a
 *    super-admin session.
 *
 * 2. **It was gated on `NODE_ENV === 'production'`,** and nothing in the
 *    repository ever set `NODE_ENV` — `start:prod` was literally `node
 *    dist/main`. The default was therefore fail-open: deploy without the env var
 *    and the endpoint shipped. The gate is now opt-in via `ENABLE_DEV_TOOLS`,
 *    so the safe state is the default.
 */
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
    summary: 'Settle a mock bank charge (development only)',
    description:
      'Signs the body with the mock bank secret and runs the real settlement path. Registered only when ENABLE_DEV_TOOLS=true, and reachable only from the loopback interface.',
  })
  @ApiOkResponse({ description: 'The settled transaction.' })
  settle(@Body() dto: BankWebhookDto, @Headers('x-forwarded-for') forwardedFor?: string) {
    // Defence in depth: even if this route were somehow registered, refuse
    // anything that did not come from the machine running the dev server.
    const remote = forwardedFor?.split(',')[0]?.trim() ?? '127.0.0.1';
    if (!remote.startsWith('127.') && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      throw new ForbiddenException(
        'The dev settlement helper only accepts loopback requests.',
      );
    }

    const signature = signWebhook(
      {
        gatewayRef: dto.gatewayRef,
        status: dto.status,
        timestamp: dto.timestamp,
        nonce: dto.nonce,
        failureCode: dto.failureCode,
        failureMessage: dto.failureMessage,
      },
      this.config.getOrThrow<string>('BANK_WEBHOOK_SECRET'),
    );
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
}