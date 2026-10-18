import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ActorType } from '@prisma/client';
import { RequestUser } from '../auth/request-user';
import { hashApiKey } from '../crypto/crypto';
import { ApiError, ErrorCode } from '../errors/api-error';
import { setRequestContext } from '../logger/logger';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PENDING_MERCHANT_KEY } from '../decorators/pending-merchant.decorator';
import { PrismaService } from '../../database/prisma.service';

/**
 * Narrow structural type so the guard does not depend on JwtService directly.
 * Bound to a concrete implementation in `AppModule`.
 *
 * `sid` is the Session id. It was minted at login but the interface narrowed it
 * away, so the guard could not consult it and revoking a session left its
 * access token usable for the full hour.
 */
export interface TokenVerifier {
  verify(token: string): Promise<{ sub: string; sid?: string }>;
}

/** DI token for the above. */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/**
 * Authenticates a request as either an API key or a session JWT.
 *
 * API keys are tried first because a merchant's server is the dominant caller
 * and should not pay for a JWT verify + a `users.findUnique` on every request.
 * A request carrying exactly one credential type is unambiguous; a request
 * carrying both is rejected rather than guessed at.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(TOKEN_VERIFIER) private readonly jwtService: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: RequestUser;
    }>();

    const apiKeyHeader = firstHeader(request.headers['x-api-key']);
    const authorization = firstHeader(request.headers.authorization);
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

    if (apiKeyHeader && bearer) {
      throw ApiError.of(
        ErrorCode.UNAUTHENTICATED,
        'Send either an API key or a login token, not both.',
      );
    }

    const principal = apiKeyHeader
      ? await this.authenticateApiKey(apiKeyHeader)
      : await this.authenticateJwt(bearer, context);

    request.user = principal;
    setRequestContext({
      actorId: principal.id,
      actorType: principal.actorType,
      merchantId: principal.merchantId ?? undefined,
    });
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return !!this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  private async authenticateApiKey(rawKey: string): Promise<RequestUser> {
    const key = await this.prisma.apiKey.findUnique({ where: { hash: hashApiKey(rawKey) } });

    if (!key) {
      throw ApiError.of(ErrorCode.INVALID_API_KEY);
    }
    if (key.revokedAt) {
      throw ApiError.of(ErrorCode.TOKEN_REVOKED, 'This API key has been revoked.');
    }
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw ApiError.of(ErrorCode.TOKEN_EXPIRED, 'This API key has expired.');
    }
    if (!key.merchantId) {
      throw ApiError.of(
        ErrorCode.FORBIDDEN,
        'This API key is not attached to a merchant and cannot call this endpoint.',
      );
    }

    const merchant = await this.prisma.merchants.findUnique({
      where: { id: key.merchantId },
      select: { status: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (merchant.status !== 'ACTIVE') {
      throw ApiError.of(
        ErrorCode.MERCHANT_NOT_ACTIVE,
        'This merchant account is not active.',
      );
    }

    // Fire-and-forget: a failure to record usage must never fail the request.
    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    // The `Users` row that owns anything this key creates.
    //
    // `Payments.userId`, `Transactions.userId` and `Resolution.actorId` are all
    // foreign keys onto `Users`. Writing `key.id` into them raised a foreign
    // key violation, so POST /payments, /transactions, /refunds and /payouts
    // all returned an opaque 500 for API-key callers — breaking the entire
    // merchant-server integration path.
    //
    // Resolving the merchant's owner account also makes idempotency
    // merchant-scoped: two keys on the same merchant replaying the same order
    // key collapse onto one row rather than minting two payments.
    const owner = await this.prisma.users.findFirst({
      where: { merchantId: key.merchantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!owner) {
      throw ApiError.of(
        ErrorCode.FORBIDDEN,
        'This API key is not attached to a merchant account with an owner.',
      );
    }

    return {
      actorType: ActorType.API_KEY,
      id: key.id,
      ownerUserId: owner.id,
      publicId: key.publicId,
      email: null,
      role: 'MERCHANT',
      status: merchant.status,
      countryCode: null,
      merchantId: key.merchantId,
      scopes: key.scopes,
    };
  }

  private async authenticateJwt(
    token: string | undefined,
    context: ExecutionContext,
  ): Promise<RequestUser> {
    if (!token) {
      throw ApiError.of(
        ErrorCode.UNAUTHENTICATED,
        'Please sign in. Send an API key or a login token.',
      );
    }

    const payload = await this.jwtService.verify(token);

    const user = await this.prisma.users.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) {
      throw ApiError.of(ErrorCode.TOKEN_EXPIRED, 'Your login session is not valid. Please sign in again.');
    }

    // A SUSPENDED user is locked out here rather than at each call site.
    // Previously the guard copied status onto the principal and never checked
    // it, so suspension only blocked the two money-write paths in
    // payment.service and transaction.service — a suspended user could still
    // read payments, list sessions, and call every other endpoint.
    if (user.status === 'SUSPENDED') {
      throw ApiError.of(
        ErrorCode.ACCOUNT_SUSPENDED,
        'This account is suspended. Contact support.',
      );
    }

    // A merchant session inherits its merchant's status.
    //
    // `authenticateApiKey` has always checked this, but the JWT branch did not
    // — so the onboarding gate was one header away from being decorative. Live
    // testing found a merchant with REJECTED KYC using a session token to
    // create a default payout destination, pre-wiring a bank account to receive
    // funds before approval.
    //
    // Deliberately NOT a blanket guard: a PENDING_REVIEW merchant must still be
    // able to read its profile and submit KYC — that is how it becomes ACTIVE.
    // `AllowPendingMerchant` opts individual routes in, so the exemption is a
    // declared decision rather than a side effect of route ordering.
    const allowPending = this.reflector.getAllAndOverride<boolean>(PENDING_MERCHANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (user.merchantId && !allowPending) {
      const merchant = await this.prisma.merchants.findUnique({
        where: { id: user.merchantId },
        select: { status: true },
      });
      if (!merchant) {
        throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
      }
      if (merchant.status !== 'ACTIVE') {
        throw ApiError.of(
          ErrorCode.MERCHANT_NOT_ACTIVE,
          'This merchant account is not active.',
        );
      }
    }

    // Honour the `sid` claim.
    // The claim was minted at login but never consulted, so revoking a session
    // left its access token usable for the full hour. `POST /auth/logout` is
    // documented as "Revoke the current session" and did not do that.
    //
    // A token without a `sid` predates this check; it is accepted rather than
    // rejected so existing sessions are not logged out by a deploy, but it
    // also cannot be revoked until it expires.
    if (typeof payload.sid === 'string') {
      const session = await this.prisma.session.findUnique({
        where: { id: payload.sid },
        select: { revokedAt: true, expiresAt: true, userId: true },
      });
      if (!session || session.userId !== user.id) {
        throw ApiError.of(
          ErrorCode.TOKEN_REVOKED,
          'Your login session is no longer valid. Please sign in again.',
        );
      }
      if (session.revokedAt) {
        throw ApiError.of(
          ErrorCode.TOKEN_REVOKED,
          'Your login session is no longer valid. Please sign in again.',
        );
      }
      if (session.expiresAt.getTime() <= Date.now()) {
        throw ApiError.of(
          ErrorCode.TOKEN_REVOKED,
          'Your login session has expired. Please sign in again.',
        );
      }
    }

    return {
      actorType: ActorType.USER,
      id: user.id,
      ownerUserId: user.id,
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      status: user.status,
      countryCode: user.countryCode,
      merchantId: user.merchantId,
      scopes: [],
      sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
    };
  }
}


function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}