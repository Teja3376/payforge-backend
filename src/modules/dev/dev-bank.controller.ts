import { Body, Controller, ForbiddenException, HttpCode, Post, Req } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
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

  // Requires a super-admin session. It was previously @Public(), which
  // contradicted its own doc comment: any process able to reach the port could
  // settle a charge with no credentials at all. `ENABLE_DEV_TOOLS` and the
  // loopback check are defence in depth, not the primary gate.
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(200)
  @Post('bank/settle')
  @ApiOperation({
    summary: 'Settle a mock bank charge (development only)',
    description:
      'Signs the body with the mock bank secret and runs the real settlement path. ' +
      'Requires a super-admin session and is registered only when ENABLE_DEV_TOOLS=true. ' +
      'Intended for local development and automated tests.',
  })
  @ApiOkResponse({ description: 'The settled transaction.' })
  @ApiForbiddenResponse({ description: 'Not a super admin.' })
  settle(
    @Body() dto: BankWebhookDto,
    @Req() request: Request,
    @CurrentUser() actor: RequestUser,
  ) {
    // Defence in depth: even with a valid admin session, refuse anything that
    // did not come from the machine running the dev server.
    //
    // The client-supplied `x-forwarded-for` header is not trusted — `main.ts`
    // configures `trust proxy`, so `request.ip` is the real peer. Reading the
    // header and defaulting to `127.0.0.1` when absent meant a request that
    // simply omitted the header was treated as loopback.
    const remote = request.ip ?? request.socket.remoteAddress ?? '';
    if (!remote.startsWith('127.') && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      throw new ForbiddenException(
        'The dev settlement helper only accepts loopback requests.',
      );
    }

    void actor;

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