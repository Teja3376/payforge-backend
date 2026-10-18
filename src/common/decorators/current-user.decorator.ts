import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser } from '../auth/request-user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    return ctx.switchToHttp().getRequest<{ user: RequestUser }>().user;
  },
);

/**
 * Read the `Idempotency-Key` request header.
 *
 * Idempotency belongs in a header, not the JSON body: the body is the request
 * signature that gets hashed to detect key reuse with a different payload, and
 * every other provider (Stripe, Adyen, Razorpay) uses the header form.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const value = ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>()
      .headers['idempotency-key'];
    return typeof value === 'string' ? value : undefined;
  },
);